import type { BitmexDataItem, BitmexTable, VaultTable } from './types';

/**
 * The vault table a message routes to, given upstream's `x-bitmex-pool` value.
 * No pool, an empty value, or `Primary` keeps the base table; any other pool
 * becomes the pseudo-table `<table>.<pool lowercased>` and flows on its own path
 * from there. Journalist is agnostic about which tables may carry a pool — it
 * just honours the header; whether the value makes sense is upstream's concern.
 */
export const poolTable = (table: BitmexTable, pool?: string): VaultTable =>
  pool && pool !== 'Primary' ? `${table}.${pool.toLowerCase()}` : table;

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
