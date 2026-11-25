// Filesystem write operations.
//
// Two write paths:
//
//   - storeFile()   — a complete pre-built gzip stream. Streamed to a temp
//                     file unique to the call, verified, and published as the
//                     .csv.gz only if none exists yet.
//
//   - appendBatch() — incremental gzip-member append. Each call appends one
//                     self-contained gzip member to the open file via a
//                     per-file @devvir/zipper writer, which owns compression,
//                     the serialised write chain, retry and recovery, and the
//                     .csv.gz.tmp → .csv.gz rename on seal.
//
// Durability: a seal fsyncs the open file before the rename and the year
// directory after it, a stored file is fsynced before it is published and the
// year directory after, and every directory this module creates is made
// durable by syncing its parent. Individual members are not fsynced.
//
// `fs/` knows nothing about row formats, CSV structure, headers, or buffering —
// callers in `data/` produce ready-to-write strings.

import {
  existsSync, mkdirSync, createReadStream, createWriteStream, readdirSync, unlinkSync, appendFileSync,
  openSync, fsyncSync, closeSync,
} from 'fs';
import { open, link, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Writable, type Readable } from 'stream';
import { createGunzip } from 'zlib';
import { logger } from '@devvir/service-kit';
import { createWriter, type Writer, type WriteFailure } from '@devvir/zipper';
import config from '../config';
import { DATA_DIR, yearDir, openPath, closedPath } from './paths';
import { recordFailure, setBackpressure } from './health';
import { AlreadyExistsError, InvalidUploadError } from './errors';

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

// closedPath() + this marker + a UUID is the temp file of one storeFile call.
const UPLOAD_MARKER = '.upload-';
const UPLOAD_NAME   = /\.csv\.gz\.upload-[0-9a-f-]{36}$/;

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
 * Stores a complete gzip stream as the closed file for table/filename.
 *
 * The stream goes to a temp file of its own next to the closed path
 * (`<filename>.csv.gz.upload-<uuid>`), so concurrent calls never share bytes
 * and the file is never visible as open. Once the stream ends the temp file
 * must be non-empty and decompress as gzip to its end (several members
 * allowed); otherwise the call rejects with InvalidUploadError. It is then
 * fsynced and published under the closed path without replacing anything: if
 * a closed file already exists the call rejects with AlreadyExistsError.
 * Finally the year directory is fsynced.
 *
 * Whenever the call rejects, its temp file is removed and no closed or open
 * file has been created or changed. A temp file left by a process that died
 * mid-call is removed by removeStaleUploads.
 */
export const storeFile = async (table: string, filename: string, source: Readable): Promise<void> => {
  const dir  = yearDir(table, filename);
  const dest = closedPath(table, filename);
  const part = `${dest}${UPLOAD_MARKER}${randomUUID()}`;

  ensureDir(dir);

  const out = createWriteStream(part, { flags: 'wx' });
  let published = false;

  try {
    await pipeline(source, out);

    if (out.bytesWritten === 0) throw new InvalidUploadError('Upload is empty');

    await verifyGzip(part);
    await fsyncFile(part);

    try {
      await link(part, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST')
        throw new AlreadyExistsError(`A closed file already exists for ${table}/${filename}`);

      throw err;
    }

    published = true;

    await unlink(part).catch((err: unknown) => {
      logger.warn({ err, part }, 'Could not remove the upload temp file after publishing');
    });

    await fsyncDir(dir);
  } catch (err) {
    // A failed pipeline can settle before the stream's open does; wait for the
    // stream to close so the temp file exists, if at all, before removing it.
    if (! out.closed) {
      const closed = new Promise<void>(resolve => out.once('close', () => resolve()));

      out.destroy();
      await closed;
    }

    if (! published) await unlink(part).catch(() => undefined);

    throw err;
  }
};

/**
 * Discards the open file for table/filename: any writer for it is aborted —
 * its queued members settle first, so none can land afterwards — and dropped,
 * then the `.csv.gz.tmp` is removed if it exists. Idempotent.
 *
 * Nothing may write the bucket while this runs: a writer created meanwhile
 * would have its file removed.
 */
export const deleteFile = async (table: string, filename: string): Promise<void> => {
  const key    = `${table}/${filename}`;
  const writer = writers.get(key);

  if (writer) {
    await writer.abort();

    if (writers.get(key) === writer) writers.delete(key);
  }

  await unlink(openPath(table, filename)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
};

/**
 * Removes the temp files of storeFile calls that never finished, under every
 * table's year directories. Meant to run at startup, before any upload can be
 * in progress. Best effort: a directory or file that cannot be read or removed
 * is logged and skipped.
 */
export const removeStaleUploads = (): void => {
  for (const tableName of listDir(DATA_DIR)) {
    const table = path.join(DATA_DIR, tableName);

    for (const year of listDir(table)) {
      if (! /^\d{4}$/.test(year)) continue;

      const dir = path.join(table, year);

      for (const name of listDir(dir)) {
        if (! UPLOAD_NAME.test(name)) continue;

        try {
          unlinkSync(path.join(dir, name));
          logger.info({ file: path.join(dir, name) }, 'Removed unfinished upload');
        } catch (err) {
          logger.warn({ err, file: path.join(dir, name) }, 'Could not remove unfinished upload');
        }
      }
    }
  }
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

/**
 * Decompresses `file` to its end, discarding the output. Rejects with
 * InvalidUploadError when the bytes are not a complete gzip stream, and with
 * the underlying error when the file cannot be read.
 */
const verifyGzip = async (file: string): Promise<void> => {
  const sink = new Writable({ write: (_chunk, _enc, done) => done() });

  try {
    await pipeline(createReadStream(file), createGunzip(), sink);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;

    if (typeof code === 'string' && code.startsWith('Z_'))
      throw new InvalidUploadError(`Upload is not a valid gzip stream: ${(err as Error).message}`);

    throw err;
  }
};

/** Names in `dir`, or none when it cannot be read (missing, not a directory). */
const listDir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && (err as NodeJS.ErrnoException).code !== 'ENOTDIR')
      logger.warn({ err, dir }, 'Could not list directory');

    return [];
  }
};

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
 * Invoked by the zipper writer when a member fails every retry. Every report is
 * logged at error level and counts toward storage health.
 *
 * When the truncate back to the last good offset also failed, zipper has
 * quarantined the file (`quarantinePath`) and continues in a fresh open file,
 * re-appending the member there; `reappendError` says that re-append failed
 * too, leaving the member only as the corrupt tail of the quarantined file.
 * Such a report also writes an `.error` sidecar next to the closed path.
 */
const onWriteFailure = (table: string, filename: string, info: WriteFailure): void => {
  if (info.truncateError) {
    logger.error(
      {
        table, filename,
        err:            info.error,
        truncateError:  info.truncateError,
        reappendError:  info.reappendError,
        quarantinePath: info.quarantinePath,
        lastGoodOffset: info.lastGoodOffset,
      },
      'Append failed and truncate failed; file quarantined',
    );

    recordFailure(`append and truncate failed for ${table}/${filename}; file quarantined`);

    writeErrorSidecar(table, filename, info);

    return;
  }

  logger.error({ table, filename, bytesDropped: info.bytesDropped }, 'Append retries exhausted, member dropped');

  recordFailure(`append retries exhausted for ${table}/${filename}`);
};

/**
 * Appends one JSON line to `<closed path>.error` describing a failure whose
 * truncate also failed: the offsets, the errors and where the file was
 * quarantined. Best effort: a sidecar that cannot be written is logged.
 */
const writeErrorSidecar = (table: string, filename: string, info: WriteFailure): void => {
  const errPath = `${closedPath(table, filename)}.error`;
  const stack   = (err: Error | undefined): string | null => err ? (err.stack ?? err.message) : null;

  try {
    const content = JSON.stringify({
      timestamp:      new Date().toISOString(),
      lastGoodOffset: info.lastGoodOffset,
      writeError:     stack(info.error),
      truncateError:  stack(info.truncateError),
      reappendError:  stack(info.reappendError),
      quarantinePath: info.quarantinePath ?? null,
      note: info.quarantinePath
        ? `Corrupt file quarantined to ${info.quarantinePath}; run gzrecover on it to extract recoverable members. A fresh open file continues from here.`
        : 'Run gzrecover on the open file to extract recoverable members.',
    }) + '\n';

    appendFileSync(errPath, content);
  } catch (err) {
    logger.error({ err, table, filename, errPath }, 'Could not write the .error sidecar');
  }
};

// ── Test helpers ──────────────────────────────────────────────────────────────

export const _test_reset = (): void => { writers.clear(); sealing.clear(); };
