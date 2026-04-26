import type { TableHandler } from '../handler';
import { makeEmptyPartial, timestampFromField, wrapAsInsert } from '../handler';
import type { BitmexTable, MongoDoc, TakeResult } from '../../types';

/**
 * Quote bucket aggregates — REST-origin, one collection per bucket size.
 * All four (1m / 5m / 1h / 1d) share the same shape and re-emit logic; only
 * the collection name and `table` field differ.
 */

const QUOTE_BIN_TYPES = {
  timestamp: 'timestamp',
  symbol:    'symbol',
  bidSize:   'long',
  bidPrice:  'float',
  askPrice:  'float',
  askSize:   'long',
  pool:      'symbol',
} as const;

const buildQuoteBinHandler = (table: BitmexTable): TableHandler => ({
  collection: table,
  origin:     'rest',

  partial: makeEmptyPartial(
    table,
    /* keys */        ['timestamp', 'symbol'],
    /* types */       QUOTE_BIN_TYPES,
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

export const quoteBin1mHandler = buildQuoteBinHandler('quoteBin1m');
export const quoteBin5mHandler = buildQuoteBinHandler('quoteBin5m');
export const quoteBin1hHandler = buildQuoteBinHandler('quoteBin1h');
export const quoteBin1dHandler = buildQuoteBinHandler('quoteBin1d');
