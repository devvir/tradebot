import type { TableHandler } from '../handler';
import { timestampFromData, wsPayload } from '../handler';
import type { MongoDoc, TakeResult, BitmexAction } from '../../types';

/**
 * chat — WS-origin.
 *
 * Trollbox messages. insert / partial. Republished as-is.
 */
export const chatHandler: TableHandler = {
  collection: 'chat',
  origin:     'ws',
  partial:    null,

  getTimestamp: timestampFromData,

  take(docs: MongoDoc[]): TakeResult | null {
    if (docs.length === 0) return null;

    const doc = docs[0];

    return {
      messages: [{
        table:     'chat',
        action:    doc.action as BitmexAction,
        timestamp: timestampFromData(doc),
        payload:   wsPayload('chat', doc),
      }],
      consumed: 1,
    };
  },
};
