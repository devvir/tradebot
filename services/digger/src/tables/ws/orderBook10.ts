import type { TableHandler } from '../handler';
import { timestampFromData, wsPayload } from '../handler';
import type { MongoDoc, TakeResult, BitmexAction } from '../../types';

/**
 * orderBook10 — WS-origin (derived from orderBookL2).
 *
 * Each WS message is a full top-10 snapshot rather than a delta. Stored as a
 * stream of WS messages by the snapshots service; republished here as-is.
 */
export const orderBook10Handler: TableHandler = {
  collection: 'orderBook10',
  origin:     'ws',
  partial:    null,

  getTimestamp: timestampFromData,

  take(docs: MongoDoc[]): TakeResult | null {
    if (docs.length === 0) return null;

    const doc = docs[0];

    return {
      messages: [{
        table:     'orderBook10',
        action:    doc.action as BitmexAction,
        timestamp: timestampFromData(doc),
        payload:   wsPayload('orderBook10', doc),
      }],
      consumed: 1,
    };
  },
};
