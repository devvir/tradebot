import type { TableHandler } from '../handler';
import { timestampFromData, wsPayload } from '../handler';
import type { MongoDoc, TakeResult, BitmexAction } from '../../types';

/**
 * orderBookL2_25 — WS-origin (derived from orderBookL2).
 *
 * Same delta stream shape as orderBookL2, just capped at 25 levels per side.
 */
export const orderBookL2_25Handler: TableHandler = {
  collection: 'orderBookL2_25',
  origin:     'ws',
  partial:    null,

  getTimestamp: timestampFromData,

  take(docs: MongoDoc[]): TakeResult | null {
    if (docs.length === 0) return null;

    const doc = docs[0];

    return {
      messages: [{
        table:     'orderBookL2_25',
        action:    doc.action as BitmexAction,
        timestamp: timestampFromData(doc),
        payload:   wsPayload('orderBookL2_25', doc),
      }],
      consumed: 1,
    };
  },
};
