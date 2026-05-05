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
import { recordFailure, setBackpressure } from './health';

const gzipAsync = promisify(gzip);

const MAX_RETRIES      = 3;
const RETRY_BACKOFF_MS = 100;

// Per-file throttle (429): a single file's inflight writes crossing
// MAX_INFLIGHT marks just that path as throttled; other files keep flowing.
// The throttle clears once that file's inflight drains back to INFLIGHT_RESUME
// (hysteresis prevents oscillation when clients retry with backoff).
const MAX_INFLIGHT    = 15;
const INFLIGHT_RESUME = 5;

interface Handle {
  path:           string;
  writing:        Promise<void>;
  lastGoodOffset: number;
  inflightCount:  number;
}

const handles = new Map<string, Handle>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Whether an open `.csv.gz.tmp` exists for table/filename — in memory or on
 * disk. Disk is the source of truth: a `.tmp` may exist from before a restart
 * with headers and significant data already written. The in-memory
 * short-circuit is only an optimisation.
 */
export const isInitialized = (table: string, filename: string): boolean => {
  const key = `${table}/${filename}`;

  return handles.has(key) || existsSync(openPath(table, filename));
};

/**
 * Appends one gzip member to the open file for table/filename. Per-handle
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
  table:    string,
  filename: string,
  lines:    string[],
  seal:     boolean = false,
): Promise<void> => {
  const handle = getOrCreateHandle(table, filename);
  const key    = `${table}/${filename}`;

  handle.inflightCount++;

  if (handle.inflightCount > MAX_INFLIGHT) setBackpressure(key, true, handle.inflightCount);

  const next = handle.writing.then(async () => {
    if (lines.length > 0) {
      await writeMember(table, filename, handle, lines);
    }

    if (seal) {
      const open   = openPath(table, filename);
      const closed = closedPath(table, filename);

      try {
        renameSync(open, closed);
        handles.delete(key);

        logger.info({ table, filename }, 'File sealed');
      } catch (err) {
        logger.error({ err, table, filename }, 'Seal rename failed');

        throw err;
      }
    }
  });

  // Swallow rejections on the chain so a single failure does not poison every
  // subsequent write for this file. The original `next` promise still rejects
  // for the caller awaiting this specific batch.
  handle.writing = next.catch(() => undefined);

  // Decrement inflight when this batch's chain slot settles (success or fail).
  // The caught promise never rejects so .then() always fires. Crossing back
  // down through INFLIGHT_RESUME clears this path's throttle exactly once.
  handle.writing.then(() => {
    const prev = handle.inflightCount;

    handle.inflightCount--;

    if (prev > INFLIGHT_RESUME && handle.inflightCount <= INFLIGHT_RESUME) {
      setBackpressure(key, false);
    }
  });

  return next;
};

/**
 * Stores a complete pre-built gzip stream (e.g. piped directly from S3 by
 * courier). Written atomically: streamed to `.csv.gz.tmp`, then renamed to
 * the final `.csv.gz`. A crashed upload leaves an open file on disk, which
 * courier handles by deleting and re-uploading.
 */
export const storeFile = async (table: string, filename: string, source: Readable): Promise<void> => {
  const tmp  = openPath(table, filename);
  const dest = closedPath(table, filename);

  mkdirSync(yearDir(table, filename), { recursive: true });

  try {
    await pipeline(source, createWriteStream(tmp));
    renameSync(tmp, dest);
  } catch (err) {
    if (existsSync(tmp)) unlinkSync(tmp);

    throw err;
  }
};

/** Idempotent unlink of the .csv.gz.tmp file. Drops any in-memory handle. */
export const deleteFile = (table: string, filename: string): void => {
  const path = openPath(table, filename);

  if (existsSync(path)) unlinkSync(path);

  handles.delete(`${table}/${filename}`);
};

/** Awaits the write chain for a given file. Returns immediately if no handle. */
export const drainHandle = async (table: string, filename: string): Promise<void> => {
  const handle = handles.get(`${table}/${filename}`);

  if (! handle) return;

  await handle.writing;
};

// ── Internals ─────────────────────────────────────────────────────────────────

const getOrCreateHandle = (table: string, filename: string): Handle => {
  const key      = `${table}/${filename}`;
  const existing = handles.get(key);

  if (existing) return existing;

  mkdirSync(yearDir(table, filename), { recursive: true });

  const path = openPath(table, filename);

  const handle: Handle = {
    path,
    writing:        Promise.resolve(),
    lastGoodOffset: existsSync(path) ? statSync(path).size : 0,
    inflightCount:  0,
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
  table:    string,
  filename: string,
  handle:   Handle,
  lines:    string[],
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
      logger.warn({ err: writeErr, attempt, table, filename }, 'Append member failed');

      try {
        // ftruncate modifies the inode size only — no data copy.
        await fsp.truncate(handle.path, handle.lastGoodOffset);
      } catch (truncErr) {
        logger.error(
          { writeErr, truncErr, table, filename, lastGoodOffset: handle.lastGoodOffset },
          'Truncate failed — file may have a corrupt partial member; continuing with new appends (recoverable via gzrecover)',
        );

        writeErrorSidecar(table, filename, handle.lastGoodOffset, writeErr as Error, truncErr as Error);

        return;
      }

      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS * (attempt + 1)));
      }
    }
  }

  logger.error({ rows: lines.length, table, filename }, 'Append retries exhausted, batch dropped');

  recordFailure(`append retries exhausted for ${table}/${filename}`);
};

/**
 * Writes a sidecar `.csv.gz.error` next to the data file describing the
 * unrecoverable corruption. Best-effort — if even this write fails, we do
 * nothing further (the stderr log from the caller is always emitted).
 */
const writeErrorSidecar = (
  table:          string,
  filename:       string,
  lastGoodOffset: number,
  writeErr:       Error,
  truncErr:       Error,
): void => {
  try {
    const errPath = `${closedPath(table, filename)}.error`;

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

export const _test_inflightCount = (table: string, filename: string): number => {
  return handles.get(`${table}/${filename}`)?.inflightCount ?? 0;
};
export const _test_reset = (): void => { handles.clear(); };
