import type { BitmexTable, MongoDoc, TableBuffer } from '../types';

/**
 * Per-table FIFO of pre-fetched MongoDB documents in ascending `_id` order.
 * The streaming engine drains a buffer's head; the fetcher refills its tail.
 */

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export const createBuffer = (table: BitmexTable): TableBuffer => ({
  table,
  entries:    [],
  cursor:     null,
  isFetching: false,
  exhausted:  false,
});

// ── Mutations ─────────────────────────────────────────────────────────────────

/** Append docs returned by the fetcher. */
export const enqueue = (buffer: TableBuffer, docs: MongoDoc[]): void => {
  for (const doc of docs) buffer.entries.push(doc);
};

/** Drop the first `n` documents after the stream has published them. */
export const dequeue = (buffer: TableBuffer, n: number): void => {
  buffer.entries.splice(0, n);
};

// ── Inspection ────────────────────────────────────────────────────────────────

export const hasNext = (buffer: TableBuffer): boolean =>
  buffer.entries.length > 0;

export const peek = (buffer: TableBuffer): MongoDoc | undefined =>
  buffer.entries[0];

/**
 * True when a background refill is warranted: not already in flight, more data
 * upstream, and the buffer has fallen below the low-watermark threshold.
 */
export const needsRefetch = (buffer: TableBuffer, lowWatermark: number): boolean =>
  ! buffer.isFetching &&
  ! buffer.exhausted  &&
  buffer.entries.length < lowWatermark;
