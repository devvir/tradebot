import type { TableHandler } from '../handler';
import { makeEmptyPartial, timestampFromField, wrapAsInsert } from '../handler';
import type { MongoDoc, TakeResult } from '../../types';

/**
 * insurance — REST-origin.
 *
 * Insurance fund balance snapshots, updated periodically. Keyed by `currency`
 * rather than `symbol`.
 */
export const insuranceHandler: TableHandler = {
  collection: 'insurance',
  origin:     'rest',

  partial: makeEmptyPartial(
    'insurance',
    /* keys */        ['currency', 'timestamp'],
    /* types */       {
      currency:      'symbol',
      timestamp:     'timestamp',
      walletBalance: 'long',
    },
    /* foreignKeys */ undefined,
    /* attributes */  { timestamp: 'sorted' },
    /* filter */      {},
  ),

  getTimestamp: timestampFromField,

  take(docs: MongoDoc[]): TakeResult | null {
    if (docs.length === 0) return null;

    return wrapAsInsert('insurance', docs[0]);
  },
};
