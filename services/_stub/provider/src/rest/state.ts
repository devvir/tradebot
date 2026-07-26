import { createTable, BitmexTable as DBTable, type BitmexMessage } from '@devvir/bitmex-database';
import { latestPartial } from '../ws/partial';
import { seekId } from '../ws/seek';
import { messageItem } from '../ws/message';
import { pick } from './columns';
import type { BitmexTable } from '@tradebot/types';
import type { Librarian } from '../librarian';
import type { DataItem, RestParams } from '../types';

/**
 * State tables (orderBookL2, instrument, liquidation) — the current row set,
 * reconstructed at the clock. These aren't stored as REST records, so the
 * provider builds them on the fly: find the last stored partial ≤ X, replay it
 * plus the subsequent deltas through a **use-and-throw** `createTable`, and
 * return the snapshot as records. Stateless — the table is built and discarded
 * per request; cheap as long as partials are scattered through the data (the
 * distiller guarantees this).
 */

/** A minimal view of the single-table accumulator (avoids the generic table typing). */
interface Acc {
  apply(message: BitmexMessage, wsPartialMode?: boolean): void;
  snapshot(): DataItem[];
}

const PAGE          = 5_000;
const DEFAULT_DEPTH = 25;

export const stateRecords = async (
  lib: Librarian, table: BitmexTable, p: RestParams,
): Promise<DataItem[]> => {
  const at    = p.endTime ?? Date.now();
  const found = await latestPartial(lib, table, at);

  if (! found) return [];

  const acc = createTable(table as unknown as DBTable) as unknown as Acc;

  acc.apply(found.msg as unknown as BitmexMessage, true);

  await replayDeltas(lib, table, found.id, at, acc);

  let rows = acc.snapshot();

  if (p.symbol)               rows = rows.filter(r => r.symbol === p.symbol);
  if (table === 'orderBookL2') rows = limitDepth(rows, p.depth ?? DEFAULT_DEPTH);

  return p.columns ? rows.map(r => pick(r, p.columns!)) : rows;
};

// ── Internal ──────────────────────────────────────────────────────────────────

/** Replay the stored deltas in `(afterId, at]` into the accumulator. */
const replayDeltas = async (
  lib: Librarian, table: BitmexTable, afterId: number, at: number, acc: Acc,
): Promise<void> => {
  const upper = await seekId(lib, table, at);
  let   from  = afterId + 1;

  while (from <= upper) {
    const docs = await lib.read(table, { from, before: upper, order: 'asc', limit: PAGE });

    if (docs.length === 0) break;

    for (const doc of docs) acc.apply(messageItem(doc).msg as unknown as BitmexMessage, true);

    from = docs[docs.length - 1]!._id + 1;

    if (docs.length < PAGE) break;
  }
};

/** orderBook/L2 `depth` — top-N levels per side (bids desc, asks asc); 0 = full. */
const limitDepth = (rows: DataItem[], depth: number): DataItem[] => {
  if (depth === 0) return rows;

  const price = (r: DataItem): number => r.price as number;

  const bids = rows.filter(r => r.side === 'Buy').sort((a, b) => price(b) - price(a)).slice(0, depth);
  const asks = rows.filter(r => r.side === 'Sell').sort((a, b) => price(a) - price(b)).slice(0, depth);

  return [...bids, ...asks];
};
