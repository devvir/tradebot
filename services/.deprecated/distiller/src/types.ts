import type { TableTypeMap, BitmexTable, BitmexFieldType } from '@devvir/bitmex-database';

/** Instrument row type from the bitmex-database / bitmex-api swagger schema. */
export type InstrumentItem = TableTypeMap[BitmexTable.Instrument];

/** An instrument WS message document stored in the instrument collection. */
export interface InstrumentMsg {
  _id:       number;
  action:    'partial' | 'insert' | 'update' | 'delete';
  timestamp: string;
  keys?:     string[];
  types?:    Record<string, BitmexFieldType>;
  filter?:   Record<string, unknown>;
  data:      Partial<InstrumentItem>[];
}

/** A row from the compositeIndex collection. */
export interface CompositeIndexRow {
  _id:         number;
  timestamp:   string;
  symbol:      string;
  indexSymbol: string;
  reference:   string;
  lastPrice:   string;    // stored as string in MongoDB — always parseFloat()
  weight:      string | null;
  logged:      string;
}

export const DISTILLER_NAMES = ['orderbook', 'instrument', 'partials'] as const;
export type DistillerName = typeof DISTILLER_NAMES[number];

export interface Config {
  database:   string;
  distillers: DistillerName[] | null;
  [key: string]: unknown;
}
