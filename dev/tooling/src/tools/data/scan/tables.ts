export type TableOrigin = 'ws' | 'rest';

export interface TableMeta {
  name:   string;
  origin: TableOrigin;
}

/**
 * The BitMEX tables tracked by `data sync`.
 *
 * WS tables are collected in real time and need preparation before use.
 * REST tables (incl. S3-sourced trade/quote) arrive as ready buckets and
 * are downloaded historically (current downloads can target any past date).
 *
 * `tick`, `trade.secondary` and `quote.secondary` are pseudo-tables (not real
 * BitMEX endpoints) but are stored and handled exactly like real REST tables.
 * The `.secondary` ones hold the Secondary liquidity pool, which began mid-April
 * 2026 (a few absent days at launch, dense since — see status/holes).
 */
export const ALL_TABLES: TableMeta[] = [
  { name: 'announcement',        origin: 'ws' },
  { name: 'chat',                origin: 'ws' },
  { name: 'connected',           origin: 'ws' },
  { name: 'instrument',          origin: 'ws' },
  { name: 'liquidation',         origin: 'ws' },
  { name: 'orderBookL2',         origin: 'ws' },
  { name: 'publicNotifications', origin: 'ws' },

  { name: 'compositeIndex',      origin: 'rest' },
  { name: 'funding',             origin: 'rest' },
  { name: 'insurance',           origin: 'rest' },
  { name: 'quote',               origin: 'rest' },
  { name: 'quote.secondary',     origin: 'rest' },
  { name: 'settlement',          origin: 'rest' },
  { name: 'tick',                origin: 'rest' },
  { name: 'trade',               origin: 'rest' },
  { name: 'trade.secondary',     origin: 'rest' },
];

export const ALL_TABLE_NAMES: ReadonlySet<string> = new Set(ALL_TABLES.map(t => t.name));

export function tableOrigin(name: string): TableOrigin | null {
  return ALL_TABLES.find(t => t.name === name)?.origin ?? null;
}
