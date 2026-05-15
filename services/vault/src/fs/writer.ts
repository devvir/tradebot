// Filesystem write operations.
//
// Two write paths:
//
//   - storeFile()   — full pre-built gzip stream from courier (PUT route).
//                     Streamed to .csv.gz.tmp, renamed to .csv.gz on success.
//
//   - appendBatch() — incremental gzip-member append (ticker, closeBucket).
//                     Each call appends one self-contained gzip member to the
//                     open file via a per-file @devvir/zipper writer, which
//                     owns compression, the serialised write chain, retry and
//                     recovery, and the .csv.gz.tmp → .csv.gz rename on seal.
//
// `fs/` knows nothing about row formats, CSV structure, headers, or buffering —
// callers in `data/` produce ready-to-write strings.

import { existsSync, mkdirSync, createWriteStream, unlinkSync, renameSync, appendFileSync } from 'fs';
import { pipeline } from 'stream/promises';
import type { Readable } from 'stream';
import { logger } from '@devvir/service-kit';
import { createWriter, type Writer, type WriteFailure } from '@devvir/zipper';
import config from '../config';
import { yearDir, openPath, closedPath } from './paths';
import { recordFailure, setBackpressure } from './health';

// Per-file durability tuning handed to the zipper writer:
//   - retries / backoff: a transient append failure is retried before the
//     recovery policy is invoked.
//   - recovery 'auto': a member that fails every retry is dropped and the file
//     truncated back to its last good offset — vault keeps the file healthy
//     and accepts the loss. If the truncate itself fails, zipper quarantines
//     the file and starts a fresh one (surfaced via onWriteFailure).
//   - high / low water marks: a single file's pending-write depth crossing
//     MAX_INFLIGHT throttles just that path (429); it clears at INFLIGHT_RESUME.
const MAX_RETRIES      = 3;
const RETRY_BACKOFF_MS = 100;
const MAX_INFLIGHT     = 15;
const INFLIGHT_RESUME  = 5;

// closedPath() + this extension is the open file — i.e. `.csv.gz` + `.tmp`.
const TMP_EXTENSION = '.tmp';

const writers = new Map<string, Writer>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Whether an open `.csv.gz.tmp` exists for table/filename — in memory or on
 * disk. Disk is the source of truth: a `.tmp` may exist from before a restart
 * with headers and significant data already written. The in-memory
 * short-circuit is only an optimisation.
 */
export const isInitialized = (table: string, filename: string): boolean => {
  const key = `${table}/${filename}`;

  return writers.has(key) || existsSync(openPath(table, filename));
};

/**
 * Appends one gzip member to the open file for table/filename. The per-file
 * zipper writer serialises writes onto its internal chain, so concurrent calls
 * queue in arrival order with no interleaving. When `seal` is true, after the
 * write (or immediately if `lines` is empty) the writer is closed — renaming
 * `.csv.gz.tmp` → `.csv.gz` — and dropped.
 *
 * The returned promise resolves when this specific batch (and any seal) is
 * complete. Under `recovery: 'auto'` a dropped member still resolves; the loss
 * is surfaced through `onWriteFailure`.
 */
export const appendBatch = (
  table:    string,
  filename: string,
  lines:    string[],
  seal:     boolean = false,
): Promise<void> => {
  const key    = `${table}/${filename}`;
  const writer = getOrCreateWriter(table, filename);

  const written = lines.length > 0
    ? writer.write(lines.map(l => l + '\n').join(''))
    : Promise.resolve();

  if (! seal) return written;

  return written
    .then(() => writer.close())
    .then(() => {
      writers.delete(key);

      logger.info({ table, filename }, 'File sealed');
    })
    .catch((err) => {
      logger.error({ err, table, filename }, 'Seal failed');

      throw err;
    });
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

/** Idempotent unlink of the .csv.gz.tmp file. Drops any in-memory writer. */
export const deleteFile = (table: string, filename: string): void => {
  const path = openPath(table, filename);

  if (existsSync(path)) unlinkSync(path);

  writers.delete(`${table}/${filename}`);
};

/** Awaits the pending writes for a given file. Returns immediately if no writer. */
export const drainHandle = async (table: string, filename: string): Promise<void> => {
  const writer = writers.get(`${table}/${filename}`);

  if (! writer) return;

  await writer.flush();
};

// ── Internals ─────────────────────────────────────────────────────────────────

const getOrCreateWriter = (table: string, filename: string): Writer => {
  const key      = `${table}/${filename}`;
  const existing = writers.get(key);

  if (existing) return existing;

  mkdirSync(yearDir(table, filename), { recursive: true });

  // createWriter resumes an existing `.csv.gz.tmp` automatically, so a writer
  // re-created after a restart picks up where the previous run left off.
  const writer = createWriter(closedPath(table, filename), {
    tmpExtension:   TMP_EXTENSION,
    level:          config.compressionLevel,
    retries:        MAX_RETRIES,
    backoffMs:      RETRY_BACKOFF_MS,
    recovery:       'auto',
    highWaterMark:  MAX_INFLIGHT,
    lowWaterMark:   INFLIGHT_RESUME,
    onWriteFailure: (info) => onWriteFailure(table, filename, info),
    onBackpressure: (busy, count) => setBackpressure(key, busy, count),
  });

  writers.set(key, writer);

  return writer;
};

/**
 * Invoked by the zipper writer when a member fails every retry. Mirrors the
 * original split: a plain drop (truncate succeeded) counts toward storage
 * health; a truncate failure instead writes an `.error` sidecar describing the
 * unrecoverable corruption — zipper has quarantined the file and started a
 * fresh one, so writes continue regardless.
 */
const onWriteFailure = (table: string, filename: string, info: WriteFailure): void => {
  if (info.truncateError) {
    writeErrorSidecar(table, filename, info.lastGoodOffset, info.error, info.truncateError, info.quarantinePath);

    return;
  }

  logger.error({ table, filename, bytesDropped: info.bytesDropped }, 'Append retries exhausted, member dropped');

  recordFailure(`append retries exhausted for ${table}/${filename}`);
};

/**
 * Writes a sidecar `.csv.gz.error` next to the data file describing the
 * unrecoverable corruption. Best-effort — if even this write fails, we do
 * nothing further (the stderr log from the writer is always emitted).
 */
const writeErrorSidecar = (
  table:          string,
  filename:       string,
  lastGoodOffset: number,
  writeErr:       Error,
  truncErr:       Error,
  quarantinePath: string | undefined,
): void => {
  try {
    const errPath = `${closedPath(table, filename)}.error`;

    const content = JSON.stringify({
      timestamp:      new Date().toISOString(),
      lastGoodOffset,
      writeError:     writeErr.stack ?? writeErr.message,
      truncateError:  truncErr.stack ?? truncErr.message,
      quarantinePath: quarantinePath ?? null,
      note: quarantinePath
        ? `Corrupt file quarantined to ${quarantinePath} — run gzrecover on it to extract recoverable members. A fresh open file continues from here.`
        : 'Run gzrecover on the open file to extract recoverable members.',
    }) + '\n';

    appendFileSync(errPath, content);
  } catch {
    // Best effort; nothing more to do.
  }
};

// ── Test helpers ──────────────────────────────────────────────────────────────

export const _test_reset = (): void => { writers.clear(); };
