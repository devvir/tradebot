// Filesystem write operations.
//
// Two write paths:
//
//   - storeFile()   — full pre-built gzip stream from courier (PUT route).
//                     Streamed to .csv.gz.tmp, renamed to .csv.gz on success.
//
//   - appendBatch() — incremental gzip-member append (ticker, closeBucket).
//                     Each call produces one self-contained gzip member
//                     appended to .csv.gz.tmp. Writes are serialised per file
//                     via a promise chain on the handle.
//
// `fs/` knows nothing about row formats, CSV structure, headers, or buffering —
// callers in `data/` produce ready-to-write strings.

import { existsSync, mkdirSync, statSync, createWriteStream, unlinkSync, renameSync, appendFileSync, promises as fsp } from 'fs';
import { gzip } from 'zlib';
import { promisify } from 'util';
import { pipeline } from 'stream/promises';
import type { Readable } from 'stream';
import { logger } from '@devvir/service-kit';
import { yearDir, openPath, closedPath } from './paths';
import { recordFailure } from './health';

const gzipAsync = promisify(gzip);

const MAX_RETRIES      = 3;
const RETRY_BACKOFF_MS = 100;

interface Handle {
  path:           string;
  writing:        Promise<void>;
  lastGoodOffset: number;
}

const handles = new Map<string, Handle>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Whether an open `.csv.gz.tmp` exists for table/date — in memory or on disk.
 * Disk is the source of truth: a `.tmp` may exist from before a restart with
 * headers and significant data already written. The in-memory short-circuit
 * is only an optimisation.
 */
export const isInitialized = (table: string, date: string): boolean => {
  const key = `${table}/${date}`;

  return handles.has(key) || existsSync(openPath(table, date));
};

/**
 * Appends one gzip member to the open file for table/date. Per-handle
 * serialisation: writes chain onto `handle.writing` so concurrent calls queue
 * in arrival order with no interleaving and no data loss. When `seal` is true,
 * after the write (or immediately if `lines` is empty) the file is renamed
 * `.csv.gz.tmp` → `.csv.gz` and the in-memory handle is dropped.
 *
 * The returned promise resolves when this specific batch (and any seal) is
 * complete. Earlier writes already in the chain may still be pending after a
 * caller awaits a particular call; that is intentional — callers care about
 * their own batch landing, not the chain in front of it.
 */
export const appendBatch = (
  table: string,
  date:  string,
  lines: string[],
  seal:  boolean = false,
): Promise<void> => {
  const handle = getOrCreateHandle(table, date);

  const next = handle.writing.then(async () => {
    if (lines.length > 0) {
      await writeMember(table, date, handle, lines);
    }

    if (seal) {
      const open   = openPath(table, date);
      const closed = closedPath(table, date);

      try {
        renameSync(open, closed);
        handles.delete(`${table}/${date}`);

        logger.info({ table, date }, 'File sealed');
      } catch (err) {
        logger.error({ err, table, date }, 'Seal rename failed');

        throw err;
      }
    }
  });

  // Swallow rejections on the chain so a single failure does not poison every
  // subsequent write for this file. The original `next` promise still rejects
  // for the caller awaiting this specific batch.
  handle.writing = next.catch(() => undefined);

  return next;
};

/**
 * Stores a complete pre-built gzip stream (e.g. piped directly from S3 by
 * courier). Written atomically: streamed to `.csv.gz.tmp`, then renamed to
 * the final `.csv.gz`. A crashed upload leaves an open file on disk, which
 * courier handles by deleting and re-uploading.
 */
export const storeFile = async (table: string, date: string, source: Readable): Promise<void> => {
  const tmp  = openPath(table, date);
  const dest = closedPath(table, date);

  mkdirSync(yearDir(table, date), { recursive: true });

  try {
    await pipeline(source, createWriteStream(tmp));
    renameSync(tmp, dest);
  } catch (err) {
    if (existsSync(tmp)) unlinkSync(tmp);

    throw err;
  }
};

/** Idempotent unlink of the .csv.gz.tmp file. Drops any in-memory handle. */
export const deleteFile = (table: string, date: string): void => {
  const path = openPath(table, date);

  if (existsSync(path)) unlinkSync(path);

  handles.delete(`${table}/${date}`);
};

/** Awaits the write chain for a given file. Returns immediately if no handle. */
export const drainHandle = async (table: string, date: string): Promise<void> => {
  const handle = handles.get(`${table}/${date}`);

  if (! handle) return;

  await handle.writing;
};

// ── Internals ─────────────────────────────────────────────────────────────────

const getOrCreateHandle = (table: string, date: string): Handle => {
  const key      = `${table}/${date}`;
  const existing = handles.get(key);

  if (existing) return existing;

  mkdirSync(yearDir(table, date), { recursive: true });

  const path = openPath(table, date);

  const handle: Handle = {
    path,
    writing:        Promise.resolve(),
    lastGoodOffset: existsSync(path) ? statSync(path).size : 0,
  };

  handles.set(key, handle);

  return handle;
};

/**
 * Writes one gzip member. On failure, truncates the file back to
 * `lastGoodOffset` and retries up to `MAX_RETRIES`. After all retries are
 * exhausted, the batch is dropped and `recordFailure` notifies the health
 * system. If truncate ALSO fails, an `.error` sidecar is written and we keep
 * appending — new members written after the corruption are recoverable with
 * `gzrecover`; stopping writes would lose the rest of the day, which is far
 * worse than a corrupted member that recovery tools can work around.
 */
const writeMember = async (
  table:  string,
  date:   string,
  handle: Handle,
  lines:  string[],
): Promise<void> => {
  // statSync reads inode metadata only — no disk I/O in the normal case.
  // Re-read on every member because a previous truncate-failure path may have
  // left the file larger than our in-memory offset.
  handle.lastGoodOffset = existsSync(handle.path) ? statSync(handle.path).size : 0;

  const data       = lines.map(l => l + '\n').join('');
  const buffer     = Buffer.from(data);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const compressed = await gzipAsync(buffer);
      await fsp.appendFile(handle.path, compressed);

      return;
    } catch (writeErr) {
      logger.warn({ err: writeErr, attempt, table, date }, 'Append member failed');

      try {
        // ftruncate modifies the inode size only — no data copy.
        await fsp.truncate(handle.path, handle.lastGoodOffset);
      } catch (truncErr) {
        logger.error(
          { writeErr, truncErr, table, date, lastGoodOffset: handle.lastGoodOffset },
          'Truncate failed — file may have a corrupt partial member; continuing with new appends (recoverable via gzrecover)',
        );

        writeErrorSidecar(table, date, handle.lastGoodOffset, writeErr as Error, truncErr as Error);

        return;
      }

      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS * (attempt + 1)));
      }
    }
  }

  logger.error({ rows: lines.length, table, date }, 'Append retries exhausted, batch dropped');

  recordFailure(`append retries exhausted for ${table}/${date}`);
};

/**
 * Writes a sidecar `.csv.gz.error` next to the data file describing the
 * unrecoverable corruption. Best-effort — if even this write fails, we do
 * nothing further (the stderr log from the caller is always emitted).
 */
const writeErrorSidecar = (
  table:          string,
  date:           string,
  lastGoodOffset: number,
  writeErr:       Error,
  truncErr:       Error,
): void => {
  try {
    const errPath = `${closedPath(table, date)}.error`;

    const content = JSON.stringify({
      timestamp:      new Date().toISOString(),
      lastGoodOffset,
      writeError:     writeErr.stack ?? writeErr.message,
      truncateError:  truncErr.stack ?? truncErr.message,
      note:           'Run gzrecover on the .csv.gz.tmp file to extract recoverable members.',
    }) + '\n';

    appendFileSync(errPath, content);
  } catch {
    // Best effort; nothing more to do.
  }
};

// ── Test helpers ──────────────────────────────────────────────────────────────

export const _test_reset = (): void => { handles.clear(); };
