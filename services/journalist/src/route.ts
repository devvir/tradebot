import { POOL_FANOUT_CHANNELS } from '@tradebot/utils';
import type { BitmexDataItem, BitmexTable, RouteGroup } from './types';

/**
 * Tables collected with one WS client per liquidity pool (order books + bins) —
 * their default stream is the fused `Aggregated` pool, so each pool is captured
 * through its own pool-filtered subscription. This is the single source of truth,
 * shared with the closer: pool participates in routing (below) and in close
 * scoping (each pool's bucket seals independently) only for these tables.
 */
const POOLED_FANOUT_TABLES: ReadonlySet<string> = new Set(POOL_FANOUT_CHANNELS);

/** True for a base table or a per-pool pseudo-table (`orderBookL2.secondary`). */
export const isPooledFanout = (table: string): boolean =>
  POOLED_FANOUT_TABLES.has(table.split('.')[0]!);

/**
 * The vault table a group is stored under. For a pooled-fanout table, non-Primary
 * data is routed to a per-pool pseudo-table (`orderBookL2` → `orderBookL2.secondary`)
 * so each pool's bucket is written and closed independently — a lagging pool client
 * can never stall or truncate another pool's bucket. Primary and non-pooled data
 * keep the base name. A message's rows all share one pool (per-pool subscription),
 * so the first row decides; an empty message keeps the base name.
 */
export const vaultTable = (table: string, data: BitmexDataItem[]): string => {
  if (! isPooledFanout(table)) return table;

  const pool = (data[0] as { pool?: string } | undefined)?.pool;

  return pool && pool !== 'Primary' ? `${table}.${pool.toLowerCase()}` : table;
};

/**
 * Split a message's data into per-target-table groups. Only `trade` fans out:
 * real prints (`size !== 0`) stay in `trade`, while referential index prints
 * (`size === 0`, on `.`-prefixed index symbols) go to the derived `tick` table —
 * mirroring how scribe collects the two from REST. Every other table (including
 * `quote`, which has no referential rows) yields a single unchanged group, as
 * does an empty message so it is never lost.
 */
export const routeMessage = (table: BitmexTable, data: BitmexDataItem[]): RouteGroup[] => {
  if (table !== 'trade' || data.length === 0)
    return [{ table, data }];

  const trades: BitmexDataItem[] = [];
  const ticks:  BitmexDataItem[] = [];

  for (const item of data)
    ((item as { size?: number }).size === 0 ? ticks : trades).push(item);

  const groups: RouteGroup[] = [];

  if (trades.length) groups.push({ table: 'trade', data: trades });
  if (ticks.length)  groups.push({ table: 'tick',  data: ticks });

  return groups;
};

/**
 * The day bucket (YYYYMMDD) a message is filed under, from the message's exchange
 * event time. Deltas share one `timestamp` across all items, but a `partial` is a
 * full-state snapshot whose items carry their own last-update times — so the
 * **maximum** item timestamp is used: it's the snapshot's emission boundary (no
 * item is newer), and for deltas it equals the shared value. Timeless tables (no
 * `timestamp`) and empty messages fall back to `date` — the collector reception
 * time. Only the bucket changes; the stored `_date_` is always the reception time.
 *
 * This picks the day only; the message's position within the day (relative to the
 * deltas around it) is decided later by `data prepare`'s sort.
 */
export const bucketDay = (data: BitmexDataItem[], date: string): string => {
  let max: string | undefined;

  for (const item of data)
    if (item && 'timestamp' in item) {
      const ts = item.timestamp as string;

      if (max === undefined || ts > max) max = ts;
    }

  return (max ?? date).slice(0, 10).replace(/-/g, '');
};
