import type { TableHandler } from '../handler';
import { timestampFromId, wsPayload } from '../handler';
import type { MongoDoc, TakeResult, BitmexAction } from '../../types';

/**
 * connected — WS-origin.
 *
 * Connected-user counter. ConnectedUsers data has no `timestamp` field, so we
 * fall back to the day-granularity `_id` decode for ordering.
 */
export const connectedHandler: TableHandler = {
  collection: 'connected',
  origin:     'ws',
  partial:    null,

  getTimestamp: timestampFromId,

  take(docs: MongoDoc[]): TakeResult | null {
    if (docs.length === 0) return null;

    const doc = docs[0];

    return {
      messages: [{
        table:     'connected',
        action:    doc.action as BitmexAction,
        timestamp: timestampFromId(doc),
        payload:   wsPayload('connected', doc),
      }],
      consumed: 1,
    };
  },
};
