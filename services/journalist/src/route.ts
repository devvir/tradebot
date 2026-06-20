import type { BitmexTable, VaultTable } from './types';

/**
 * The vault table a message routes to, given upstream's `x-bitmex-pool` value.
 * No pool, an empty value, or `Primary` keeps the base table; any other pool
 * becomes the pseudo-table `<table>.<pool lowercased>` and flows on its own path
 * from there. Journalist is agnostic about which tables may carry a pool — it
 * just honours the header; whether the value makes sense is upstream's concern.
 */
export const poolTable = (table: BitmexTable, pool?: string): VaultTable =>
  pool && pool !== 'Primary' ? `${table}.${pool.toLowerCase()}` : table;
