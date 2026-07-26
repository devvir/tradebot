import type { BitmexTable } from '@devvir/bitmex-database';

/* ------------------------------------------------------------------ */
/*  Partials distiller                                                */
/* ------------------------------------------------------------------ */

/**
 * Shape of the mongo docs for a given table:
 *   - 'message': `{_id, action, data}` — raw WS envelope (e.g. orderBookL2)
 *   - 'item':    `{_id, ...itemFields}` — flat per-item storage (trade/quote/funding/…)
 */
export type DocShape = 'message' | 'item';

export interface PartialConfig {
  table:      BitmexTable;
  collection: string;
  shape:      DocShape;
}

export interface StoredPartial {
  _id:   string;
  table: string;
  date:  string;
  keys:  string[];
  types: Record<string, string>;
  data:  unknown[];
}
