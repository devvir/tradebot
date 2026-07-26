import { seekId } from '../ws/seek';
import { pick } from './columns';
import type { BitmexTable } from '@tradebot/types';
import type { Librarian } from '../librarian';
import type { DataItem, RestParams } from '../types';

/**
 * Recent tables (chat, announcement) — the last `count` records at-or-before the
 * clock, newest-first. BitMEX does not time-filter these endpoints. They are
 * stored as WS insert messages, so the records are the `data` items inside them.
 */
export const recentRecords = async (
  lib: Librarian, table: BitmexTable, p: RestParams,
): Promise<DataItem[]> => {
  const at     = p.endTime ?? Date.now();
  const before = await seekId(lib, table, at);

  const docs = await lib.read(table, { before, order: 'desc', limit: p.count });

  const rows: DataItem[] = [];

  for (const doc of docs) {
    for (const item of (doc.data as DataItem[] | undefined) ?? []) rows.push(item);
  }

  const sliced = rows.slice(0, p.count);

  return p.columns ? sliced.map(r => pick(r, p.columns!)) : sliced;
};
