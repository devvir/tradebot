import { toMs } from './time';
import type { BitmexTable } from '@tradebot/types';
import type { StoredDoc, StreamItem, DataItem, Grouped } from '../types';

/**
 * Flat-record tables (trade, quote, funding, bins, …) are stored as individual
 * records. BitMEX delivers them on WS as `insert` messages, so each record is
 * wrapped — and `trade` records that share `timestamp + symbol` are grouped into
 * one insert (a sweep). Light, O(n) envelope work; nothing heavy on this path.
 */

const stripId = ({ _id: _dropId, ...rest }: StoredDoc): DataItem => rest;

// ── Public API ────────────────────────────────────────────────────────────────

/** Wrap one flat record as a single-item insert. */
export const wrapInsert = (table: BitmexTable, doc: StoredDoc): StreamItem => ({
  ts:  toMs(doc.timestamp as string),
  msg: { table, action: 'insert', data: [stripId(doc)] },
});

/**
 * Group consecutive records sharing `timestamp + symbol` into one insert each.
 * When `full` (the batch hit its limit, so more may follow), the trailing group
 * is held back — it might continue in the next batch — and `consumedId` stops
 * before it. Exception: a batch that is entirely one group is emitted whole (it
 * would otherwise stall) — the rare sweep that straddles a batch boundary and
 * splits into two inserts.
 */
export const groupBySweep = (table: BitmexTable, docs: StoredDoc[], full: boolean): Grouped => {
  const items: StreamItem[] = [];
  let   consumedId: number | null = null;
  let   i = 0;

  while (i < docs.length) {
    const ts  = docs[i]!.timestamp as string;
    const sym = docs[i]!.symbol    as string;

    let j = i + 1;

    while (j < docs.length && docs[j]!.timestamp === ts && docs[j]!.symbol === sym) j++;

    const trailing = j === docs.length;

    if (trailing && full && items.length > 0) break;

    items.push({
      ts:  toMs(ts),
      msg: { table, action: 'insert', data: docs.slice(i, j).map(stripId) },
    });

    consumedId = docs[j - 1]!._id;
    i = j;
  }

  return { items, consumedId };
};
