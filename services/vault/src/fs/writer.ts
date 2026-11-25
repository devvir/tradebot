// Filesystem write operations.
//
// Two write paths:
//
//   - storeFile()   — full pre-built gzip stream (PUT route).
//                     Streamed to .csv.gz.tmp, renamed to .csv.gz on success.
//
//   - appendBatch() — incremental gzip-member append. Each call appends one
//                     self-contained gzip member to the open file via a
//                     per-file @devvir/zipper writer, which owns compression,
//                     the serialised write chain, retry and recovery, and the
//                     .csv.gz.tmp → .csv.gz rename on seal.
//
// Durability: a seal fsyncs the open file before the rename and the year
// directory after it, and every directory this module creates is made durable
// by syncing its parent. Individual members are not fsynced.
//
// `fs/` knows nothing about row formats, CSV structure, headers, or buffering —
// callers in `data/` produce ready-to-write strings.

import {
  existsSync, mkdirSync, createWriteStream, unlinkSync, renameSync, appendFileSync,
  openSync, fsyncSync, closeSync,
} from 'fs';
import { open } from 'fs/promises';
import path from 'path';
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

// Seals in progress. A seal's rename runs after the writer's chain has
// drained, so awaiting `flush()` alone does not cover it.
const sealing = new Set<Promise<void>>();

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
 * queue in arrival order with no interleaving. The writer is looked up (or
 * created) and the member enqueued synchronously, before the returned promise
 * settles, so two calls made in a row always land in call order.
 *
 * When `seal` is true, once every member queued so far is on disk the open
 * file is fsynced, the writer is closed — renaming `.csv.gz.tmp` → `.csv.gz` —
 * and the year directory is fsynced. The writer is dropped whether the seal
 * succeeds or fails, so a later call starts a fresh writer that resumes the
 * open file.
 *
 * The returned promise resolves when this specific batch (and any seal) is
 * complete, and rejects on any failure, including creating the directory.
 * Under `recovery: 'auto'` a dropped member still resolves; the loss is
 * surfaced through `onWriteFailure`.
 */
export const appendBatch = async (
  table:    string,
  filename: string,
  lines:    string[],
  seal:     boolean = false,
): Promise<void> => {
  const writer = getOrCreateWriter(table, filename);

  const written = lines.length > 0
    ? writer.write(lines.map(l => l + '\n').join(''))
    : Promise.resolve();

  if (! seal) return written;

  const sealed = sealWriter(table, filename, writer, written);

  sealing.add(sealed);

  try {
    await sealed;
  } finally {
    sealing.delete(sealed);
  }
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

  ensureDir(yearDir(table, filename));

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

/**
 * Resolves once every write and seal started before the call has settled,
 * successfully or not. Failures are reported where each write or seal was
 * started, not here.
 */
export const drainAll = async (): Promise<void> => {
  await Promise.allSettled([...writers.values()].map(w => w.flush()));
  await Promise.allSettled([...sealing]);
};

/** Flushes a file's data and metadata to stable storage. */
export const fsyncFile = async (file: string): Promise<void> => {
  await syncPath(file);
};

/**
 * Makes the entries of a directory durable: files and directories created,
 * renamed or removed in it survive a power loss once this resolves.
 */
export const fsyncDir = async (dir: string): Promise<void> => {
  await syncPath(dir);
};

// ── Internals ─────────────────────────────────────────────────────────────────

const getOrCreateWriter = (table: string, filename: string): Writer => {
  const key      = `${table}/${filename}`;
  const existing = writers.get(key);

  if (existing) return existing;

  ensureDir(yearDir(table, filename));

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
 * Waits for every member queued on `writer`, fsyncs the open file, closes the
 * writer (the rename) and fsyncs the year directory. The writer leaves the map
 * however this ends; a closed zipper writer refuses further writes and returns
 * the same result to every later close.
 */
const sealWriter = async (
  table:    string,
  filename: string,
  writer:   Writer,
  written:  Promise<void>,
): Promise<void> => {
  const key = `${table}/${filename}`;

  try {
    await written;
    await writer.flush();
    await fsyncFile(openPath(table, filename));
    await writer.close();
    await fsyncDir(yearDir(table, filename));

    logger.info({ table, filename }, 'File sealed');
  } catch (err) {
    logger.error({ err, table, filename }, 'Seal failed');

    throw err;
  } finally {
    if (writers.get(key) === writer) writers.delete(key);
  }
};

/**
 * Creates `dir` and any missing parents. A new directory's entry lives in its
 * parent, so the parent of every directory created here is fsynced before
 * returning. This runs synchronously so a writer can be created and used
 * within one call; it does work only when a directory is actually created.
 */
const ensureDir = (dir: string): void => {
  const created = mkdirSync(dir, { recursive: true });

  if (created === undefined) return;

  for (let d = dir; ; d = path.dirname(d)) {
    syncPathSync(path.dirname(d));

    if (d === created || path.dirname(d) === d) break;
  }
};

const syncPath = async (p: string): Promise<void> => {
  const handle = await open(p, 'r');

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const syncPathSync = (p: string): void => {
  const fd = openSync(p, 'r');

  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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

export const _test_reset = (): void => { writers.clear(); sealing.clear(); };
