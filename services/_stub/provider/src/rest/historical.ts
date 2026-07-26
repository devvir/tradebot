import { seekId } from '../ws/seek';
import { pick } from './columns';
import type { BitmexTable } from '@tradebot/types';
import type { Librarian } from '../librarian';
import type { DataItem, RestParams } from '../types';

/**
 * Historical-range tables (trade, quote, funding, settlement, insurance, bins) —
 * records over a time window, either direction. A near pass-through to librarian.
 *
 * Time bounds map to `_id` bounds via seek (no timestamp index); the `timestamp`
 * range is also applied as a filter to trim precisely. `start` is satisfied by
 * over-reading then slicing (librarian has no skip).
 */
export const historicalRecords = async (
  lib: Librarian, table: BitmexTable, p: RestParams,
): Promise<DataItem[]> => {
  const filter: Record<string, unknown> = {};

  if (p.symbol) filter.symbol = p.symbol;

  const range: Record<string, string> = {};

  if (p.startTime !== undefined) range.$gte = new Date(p.startTime).toISOString();
  if (p.endTime   !== undefined) range.$lte = new Date(p.endTime).toISOString();

  if (Object.keys(range).length > 0) filter.timestamp = range;

  const from   = p.startTime !== undefined ? await seekId(lib, table, p.startTime) : undefined;
  const before = p.endTime   !== undefined ? await seekId(lib, table, p.endTime)   : undefined;

  const docs = await lib.read(table, {
    from,
    before,
    order:  p.reverse ? 'desc' : 'asc',
    limit:  p.start + p.count,
    filter,
  });

  const sliced = docs
    .slice(p.start, p.start + p.count)
    .map(({ _id: _dropId, ...rest }) => rest as DataItem);

  return p.columns ? sliced.map(d => pick(d, p.columns!)) : sliced;
};
