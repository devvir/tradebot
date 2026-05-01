// In-memory buffers for streaming writes.
//
// One buffer per `table/filename`. Buffers store CSV-encoded lines (the
// encoding step happens in `data/encode.ts` before push). Strict FIFO; flushes
// are synchronous and atomic — no interleaving is possible at the buffer level.

import type { Buffer, FlushResult } from './types';

// Both triggers in `flushReady` use these. `STALE_THRESHOLD_MS` is generous
// (10s) so size is the leading trigger for fast tables; only quiet tables fall
// back on the time trigger.
const STALE_THRESHOLD_MS = 10_000;
const BATCH_SIZE         = 10_000;

const createBuffer = (table: string, filename: string): Buffer => {
  const lines: string[] = [];
  let lastFlushedAt     = Date.now();

  return {
    table,
    filename,

    push(line)     { lines.push(line);     },
    pushMany(many) { lines.push(...many);  },

    count()       { return lines.length;  },
    lastFlushed() { return lastFlushedAt; },

    flush() {
      lastFlushedAt = Date.now();

      return lines.splice(0);
    },
  };
};

const map = new Map<string, Buffer>();

/** Returns the buffer for a given table/filename, creating it on first access. */
const get = (table: string, filename: string): Buffer => {
  const key = `${table}/${filename}`;

  const existing = map.get(key);

  if (existing) return existing;

  const buf = createBuffer(table, filename);

  map.set(key, buf);

  return buf;
};

/**
 * Iterates all buffers and flushes those that are stale (time elapsed since
 * last flush) or full (count past `BATCH_SIZE`). Both triggers are evaluated
 * together in one pass — a buffer flushed for size also resets `lastFlushed`,
 * so the time trigger does not fire again on the same tick.
 *
 * Empty buffers are skipped silently.
 */
const flushReady = (): FlushResult[] => {
  const now     = Date.now();
  const results: FlushResult[] = [];

  for (const buf of map.values()) {
    if (buf.count() === 0) continue;

    const stale = (now - buf.lastFlushed()) >= STALE_THRESHOLD_MS;
    const full  = buf.count() >= BATCH_SIZE;

    if (! stale && ! full) continue;

    results.push({ table: buf.table, filename: buf.filename, lines: buf.flush() });
  }

  return results;
};

/**
 * Flushes every non-empty buffer unconditionally. Used at shutdown to drain
 * everything before the process exits.
 */
const flushAll = (): FlushResult[] => {
  const results: FlushResult[] = [];

  for (const buf of map.values()) {
    if (buf.count() === 0) continue;

    results.push({ table: buf.table, filename: buf.filename, lines: buf.flush() });
  }

  return results;
};

export const buffers = { get, flushReady, flushAll };

// ── Test helpers ──────────────────────────────────────────────────────────────

export const _test_reset           = (): void   => { map.clear(); };
export const _test_STALE_THRESHOLD = (): number => STALE_THRESHOLD_MS;
export const _test_BATCH_SIZE      = (): number => BATCH_SIZE;
