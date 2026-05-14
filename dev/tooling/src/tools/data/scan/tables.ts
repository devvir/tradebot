export type TableOrigin = 'ws' | 'rest';

export interface TableMeta {
  name:   string;
  origin: TableOrigin;
}

/**
 * The 13 BitMEX tables tracked by `data sync`.
 *
 * WS tables are collected in real time and need preparation before use.
 * REST tables (incl. S3-sourced trade/quote) arrive as ready buckets and
 * are downloaded historically (current downloads can target any past date).
 */
export const ALL_TABLES: TableMeta[] = [
  { name: 'announcement',        origin: 'ws'                 },
  { name: 'chat',                origin: 'ws'                 },
  { name: 'connected',           origin: 'ws'                 },
  { name: 'instrument',          origin: 'ws'                 },
  { name: 'liquidation',         origin: 'ws'                 },
  { name: 'orderBookL2',         origin: 'ws'                 },
  { name: 'publicNotifications', origin: 'ws'                 },
  { name: 'compositeIndex',      origin: 'rest'               },
  { name: 'funding',             origin: 'rest'               },
  { name: 'insurance',           origin: 'rest'               },
  { name: 'settlement',          origin: 'rest'               },
  { name: 'trade',               origin: 'rest'               },
  { name: 'quote',               origin: 'rest'               },
];

export const ALL_TABLE_NAMES: ReadonlySet<string> = new Set(ALL_TABLES.map(t => t.name));

export function tableOrigin(name: string): TableOrigin | null {
  return ALL_TABLES.find(t => t.name === name)?.origin ?? null;
}
