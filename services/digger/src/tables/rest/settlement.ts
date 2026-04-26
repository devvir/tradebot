import type { TableHandler } from '../handler';
import { makeEmptyPartial, timestampFromField, wrapAsInsert } from '../handler';
import type { MongoDoc, TakeResult } from '../../types';

/**
 * settlement — REST-origin.
 *
 * Contract expiry / index settlement events. Extremely sparse.
 */
export const settlementHandler: TableHandler = {
  collection: 'settlement',
  origin:     'rest',

  partial: makeEmptyPartial(
    'settlement',
    /* keys */        ['timestamp', 'symbol'],
    /* types */       {
      timestamp:             'timestamp',
      symbol:                'symbol',
      settlementType:        'symbol',
      settledPrice:          'float',
      optionStrikePrice:     'float',
      optionUnderlyingPrice: 'float',
      bankrupt:              'long',
      taxBase:               'long',
      taxRate:               'float',
    },
    /* foreignKeys */ { symbol: 'instrument' },
    /* attributes */  { timestamp: 'sorted', symbol: 'grouped' },
    /* filter */      {},
  ),

  getTimestamp: timestampFromField,

  take(docs: MongoDoc[]): TakeResult | null {
    if (docs.length === 0) return null;

    return wrapAsInsert('settlement', docs[0]);
  },
};
