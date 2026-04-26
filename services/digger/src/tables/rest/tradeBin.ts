import type { TableHandler } from '../handler';
import { makeEmptyPartial, timestampFromField, wrapAsInsert } from '../handler';
import type { BitmexTable, MongoDoc, TakeResult } from '../../types';

/**
 * Trade bucket aggregates — REST-origin, one collection per bucket size.
 * All four (1m / 5m / 1h / 1d) share the same shape and re-emit logic; only
 * the collection name and `table` field differ.
 */

const TRADE_BIN_TYPES = {
  timestamp:       'timestamp',
  symbol:          'symbol',
  open:            'float',
  high:            'float',
  low:             'float',
  close:           'float',
  trades:          'long',
  volume:          'long',
  vwap:            'float',
  lastSize:        'long',
  turnover:        'long',
  homeNotional:    'float',
  foreignNotional: 'float',
} as const;

const buildTradeBinHandler = (table: BitmexTable): TableHandler => ({
  collection: table,
  origin:     'rest',

  partial: makeEmptyPartial(
    table,
    /* keys */        ['timestamp', 'symbol'],
    /* types */       TRADE_BIN_TYPES,
    /* foreignKeys */ { symbol: 'instrument' },
    /* attributes */  { timestamp: 'sorted', symbol: 'grouped' },
    /* filter */      {},
  ),

  getTimestamp: timestampFromField,

  take(docs: MongoDoc[]): TakeResult | null {
    if (docs.length === 0) return null;

    return wrapAsInsert(table, docs[0]);
  },
});

export const tradeBin1mHandler = buildTradeBinHandler('tradeBin1m');
export const tradeBin5mHandler = buildTradeBinHandler('tradeBin5m');
export const tradeBin1hHandler = buildTradeBinHandler('tradeBin1h');
export const tradeBin1dHandler = buildTradeBinHandler('tradeBin1d');
