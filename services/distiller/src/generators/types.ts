import type { BitmexTable, Table, TableTypeMap } from '@devvir/bitmex-database';

import type { InstrumentItem, CompositeIndexRow } from '../types';
import type { RollingState }                     from './instrument.rolling';

export type BinSize = '1m' | '5m' | '1h' | '1d';

export type Range = {
  from: string;
  to:   string;
};

/* ------------------------------------------------------------------ */
/*  Instrument generator                                              */
/* ------------------------------------------------------------------ */

/** Vault source that contributes to the instrument generator. */
export type InstrumentSource = 'compositeIndex' | 'quote' | 'trade' | 'funding' | 'settlement';

/** Lightweight per-symbol cache for fields that depend on multiple sources. */
export interface InstrumentSymCacheEntry {
  lastPrice?: number;
  markPrice?: number;
  bidPrice?:  number;
  askPrice?:  number;
  tickSize?:  number;
}

/** Tagged event from the merged multi-source stream, used in the per-day processor. */
export type InstrumentTaggedEvent =
  | { source: 'compositeIndex'; ms: number; _id: number; row: CompositeIndexRow }
  | { source: 'trade';          ms: number; _id: number; row: TableTypeMap[BitmexTable.Trade]      & { _id: number } }
  | { source: 'quote';          ms: number; _id: number; row: TableTypeMap[BitmexTable.Quote]      & { _id: number } }
  | { source: 'funding';        ms: number; _id: number; row: TableTypeMap[BitmexTable.Funding]    & { _id: number } }
  | { source: 'settlement';     ms: number; _id: number; row: TableTypeMap[BitmexTable.Settlement] & { _id: number } };

/** Mutable state carried through a single `distillInstrument` run. */
export interface InstrumentRunState {
  table:        Table<InstrumentItem>;
  rolling:      Map<string, RollingState>;
  symCache:     Map<string, InstrumentSymCacheEntry>;
  refMap:       Map<string, string[]>;
  knownSymbols: Set<string>;
  deadSymbols:  Set<string>;
  settled:      Set<string>;

  /** ms of the last emitted minute-cron tick; undefined until the first fires. */
  lastCronMs: number | undefined;
}

/* ------------------------------------------------------------------ */
/*  Partials generator                                                */
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
  table:         BitmexTable;
  collection:    string;
  shape:         DocShape;
  binFlavor?:    BinFlavor;
}

export interface StoredPartial {
  _id:       string;
  table:     string;
  date:      string;
  keys:      string[];
  types:     Record<string, string>;
  data:      unknown[];
}
