import type { TableHandler } from '../handler';
import { makeEmptyPartial, timestampFromField, wrapAsInsert } from '../handler';
import type { MongoDoc, TakeResult } from '../../types';

/**
 * quote — REST-origin.
 *
 * One MongoDB doc = one best-bid/ask snapshot. Always single-item insert
 * messages per the WS stream analysis (no sweep grouping).
 */
export const quoteHandler: TableHandler = {
  collection: 'quote',
  origin:     'rest',

  partial: makeEmptyPartial(
    'quote',
    /* keys */        [],
    /* types */       {
      timestamp: 'timestamp',
      symbol:    'symbol',
      bidSize:   'long',
      bidPrice:  'float',
      askPrice:  'float',
      askSize:   'long',
      pool:      'symbol',
    },
    /* foreignKeys */ { symbol: 'instrument' },
    /* attributes */  { timestamp: 'sorted', symbol: 'grouped' },
    /* filter */      {},
  ),

  getTimestamp: timestampFromField,

  take(docs: MongoDoc[]): TakeResult | null {
    if (docs.length === 0) return null;

    return wrapAsInsert('quote', docs[0]);
  },
};
