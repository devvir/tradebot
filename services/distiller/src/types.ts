export type {
  TradeData       as TradeRow,
  QuoteDataFull   as QuoteRow,
  OrderBookL2Data as OrderBookL2Row,
} from '@tradebot/types';

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

/** A row from the compositeIndex vault collection. */
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

/** Derived OHLCV trade bin document. */
export interface TradeBin {
  _id:              number;
  timestamp:        string;
  symbol:           string;
  open:             number;
  high:             number;
  low:              number;
  close:            number;
  trades:           number;
  volume:           number;
  vwap?:            number;
  lastSize?:        number;
  turnover?:        number;
  homeNotional?:    number;
  foreignNotional?: number;
  pool?:            string;
}

/** Derived OHLC quote bin document. */
export interface QuoteBin {
  _id:       number;
  timestamp: string;
  symbol:    string;
  bidSize?:  number;
  bidPrice?: number;
  askPrice?: number;
  askSize?:  number;
  pool?:     string;
}

/** Derived top-10 order book snapshot document. */
export interface OrderBook10 {
  _id:        number;
  symbol:     string;
  bids:       [number, number][];
  asks:       [number, number][];
  timestamp?: string;
}

/** Output from a transform function: a collection name + documents to insert. */
export interface DerivedOutput {
  collection: string;
  docs:       object[];
}

export const DISTILLER_NAMES = ['quote', 'trade', 'orderbook', 'instrument', 'partials'] as const;
export type DistillerName = typeof DISTILLER_NAMES[number];

export interface Config {
  database:   string;
  distillers: DistillerName[] | null;
  vaultUrl:   string;
  [key: string]: unknown;
}
