import type { TableHandler } from '../handler';
import { makeEmptyPartial, timestampFromField, wrapAsInsert } from '../handler';
import type { MongoDoc, TakeResult } from '../../types';

/**
 * funding — REST-origin.
 *
 * Funding events arrive once every 8 hours per instrument — extremely sparse.
 */
export const fundingHandler: TableHandler = {
  collection: 'funding',
  origin:     'rest',

  partial: makeEmptyPartial(
    'funding',
    /* keys */        ['timestamp', 'symbol'],
    /* types */       {
      timestamp:        'timestamp',
      symbol:           'symbol',
      fundingInterval:  'timespan',
      fundingRate:      'float',
      fundingRateDaily: 'float',
    },
    /* foreignKeys */ { symbol: 'instrument' },
    /* attributes */  { timestamp: 'sorted', symbol: 'grouped' },
    /* filter */      {},
  ),

  getTimestamp: timestampFromField,

  take(docs: MongoDoc[]): TakeResult | null {
    if (docs.length === 0) return null;

    return wrapAsInsert('funding', docs[0]);
  },
};
