import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'fs';
import { createGzip, type Gzip } from 'zlib';
import { finished } from 'stream/promises';
import { logger } from '@devvir/service-kit';
import { yearDir, openPath } from './paths';
import { rowToCsv } from '@tradebot/utils';
import { TABLE_HEADERS } from './headers';
import { recordFailure } from '../health';
import type { Row } from '../types';

// ── Tuning ────────────────────────────────────────────────────────────────────
//
// Rows are buffered in memory per (table,date) and flushed to the gzip stream
// in batches. A single `gz.write()` of a large chunk is dramatically cheaper
// than thousands of small ones — both for the gzip pipeline and the writable
// backpressure machinery underneath it.
//
// Either trigger flushes the buffer:
//   - BATCH_ROWS:        upper bound on memory per file at peak rates
//   - FLUSH_INTERVAL_MS: upper bound on how long a row can sit unflushed
//
// 202 means "accepted" (same contract as before). Anything still buffered when
// the process dies is lost — vault clients are expected to retry, and high‑rate
// backfills can be replayed.

const BATCH_ROWS        = 10_000;
const FLUSH_INTERVAL_MS = 1_000;

// ── Types ─────────────────────────────────────────────────────────────────────

interface OpenFile {
  gz:         Gzip;
  file:       WriteStream;
  buffer:     string[];
  flushTimer: NodeJS.Timeout | null;
}

// ── State ─────────────────────────────────────────────────────────────────────

export const handles: Map<string, OpenFile> = new Map();
export const closing: Set<string>           = new Set();
export const headers: Map<string, string[]> = new Map();

// ── Public API ────────────────────────────────────────────────────────────────

export const isClosing = (table: string, date: string): boolean =>
  closing.has(`${table}/${date}`);

export const insertRow = (table: string, date: string, row: Row): void => {
  const key = `${table}/${date}`;

  if (closing.has(key)) return;

  const open = getOrCreateHandle(table, date, row);
  if (! open) return;

  const cols = headers.get(key)!;

  open.buffer.push(rowToCsv(row, cols) + '\n');

  scheduleFlush(open);
};

export const insertRows = (table: string, date: string, rows: Row[]): void => {
  if (rows.length === 0) return;

  const key = `${table}/${date}`;

  if (closing.has(key)) return;

  const open = getOrCreateHandle(table, date, rows[0]!);
  if (! open) return;

  const cols = headers.get(key)!;

  for (const row of rows) {
    open.buffer.push(rowToCsv(row, cols) + '\n');
  }

  scheduleFlush(open);
};

/**
 * Ends the gzip stream and resolves once the underlying file is fully flushed
 * to disk. Drains the in‑memory buffer first so no accepted row is dropped.
 */
export const closeHandle = async (key: string): Promise<void> => {
  const open = handles.get(key);
  handles.delete(key);
  headers.delete(key);

  if (! open) return;

  flushBuffer(open);

  open.gz.end();
  await finished(open.file);
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Returns the open gz+file pair for a table/date, creating a new one if none
 * exists. When the file already exists on disk (either from a previous session
 * or from a handle that was dropped mid-day due to a stream error), the new
 * gz stream is *appended* to it — concatenated gzip members are valid gzip
 * and decompress back to one continuous CSV. The header is only written for
 * the first member so the final CSV has a single header line.
 */
const getOrCreateHandle = (table: string, date: string, row: Row): OpenFile | null => {
  const key = `${table}/${date}`;

  if (handles.has(key)) return handles.get(key)!;

  mkdirSync(yearDir(table, date), { recursive: true });

  const filePath = openPath(table, date);
  const isNew    = ! existsSync(filePath);

  if (! headers.has(key))
    headers.set(key, TABLE_HEADERS[table] ?? Object.keys(row));

  const gz   = createGzip();
  const file = createWriteStream(filePath, { flags: 'a' });

  gz.pipe(file);

  const open: OpenFile = { gz, file, buffer: [], flushTimer: null };

  gz.on('error', (err) => {
    logger.error({ err, table, date }, 'Gzip stream error');
    discardHandle(key, open, `gzip stream error for ${key}: ${(err as Error).message}`);
  });

  file.on('error', (err) => {
    logger.error({ err, table, date }, 'Write stream error');
    discardHandle(key, open, `file write error for ${key}: ${(err as Error).message}`);
  });

  handles.set(key, open);

  if (isNew) open.buffer.push(headers.get(key)!.join(',') + '\n');

  return open;
};

const scheduleFlush = (open: OpenFile): void => {
  if (open.buffer.length >= BATCH_ROWS) {
    flushBuffer(open);
    return;
  }

  if (! open.flushTimer) {
    open.flushTimer = setTimeout(() => flushBuffer(open), FLUSH_INTERVAL_MS);
  }
};

const flushBuffer = (open: OpenFile): void => {
  if (open.flushTimer) {
    clearTimeout(open.flushTimer);
    open.flushTimer = null;
  }

  if (open.buffer.length === 0) return;

  const data = open.buffer.join('');
  open.buffer = [];

  open.gz.write(data);
};

const discardHandle = (key: string, open: OpenFile, reason: string): void => {
  if (open.flushTimer) {
    clearTimeout(open.flushTimer);
    open.flushTimer = null;
  }

  open.buffer = [];

  if (handles.get(key) === open) {
    handles.delete(key);
    headers.delete(key);
  }

  recordFailure(reason);
};

// ─── Test aliases (do not use outside of tests) ───────────────────────────────

export const _test_flushAll = (): void => {
  for (const open of handles.values()) flushBuffer(open);
};
