import type { TableHandler } from '../handler';
import { timestampFromData, wsPayload } from '../handler';
import type { MongoDoc, TakeResult, BitmexAction } from '../../types';

/**
 * orderBookL2 — WS-origin.
 *
 * Full L2 delta stream: partial / insert / update / delete. Republished as-is.
 */
export const orderBookL2Handler: TableHandler = {
  collection: 'orderBookL2',
  origin:     'ws',
  partial:    null,

  getTimestamp: timestampFromData,

  take(docs: MongoDoc[]): TakeResult | null {
    if (docs.length === 0) return null;

    const doc = docs[0];

    return {
      messages: [{
        table:     'orderBookL2',
        action:    doc.action as BitmexAction,
        timestamp: timestampFromData(doc),
        payload:   wsPayload('orderBookL2', doc),
      }],
      consumed: 1,
    };
  },
};
