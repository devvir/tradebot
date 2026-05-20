import type { BitmexTable } from '@devvir/bitmex-database';

export type BinSize = '1m' | '5m' | '1h' | '1d';

export type Range = {
  from: string;
  to:   string;
};

/* ------------------------------------------------------------------ */
/*  Partials distiller                                                */
/* ------------------------------------------------------------------ */

/**
 * Shape of the mongo docs for a given table:
 *   - 'message': `{_id, action, data}` — raw WS envelope (e.g. orderBookL2)
 *   - 'item':    `{_id, ...itemFields}` — flat per-item storage (trade/quote/bins/…)
 */
export type DocShape = 'message' | 'item';

/** Flavor for bin-shaped tables — governs midnight synthesis on a missing day. */
export type BinFlavor = 'trade' | 'quote' | null;

export interface PartialConfig {
  table:      BitmexTable;
  collection: string;
  shape:      DocShape;
  binFlavor?: BinFlavor;
}

export interface StoredPartial {
  _id:   string;
  table: string;
  date:  string;
  keys:  string[];
  types: Record<string, string>;
  data:  unknown[];
}
