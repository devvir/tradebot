import type { TableHandler } from '../handler';
import { timestampFromData, wsPayload } from '../handler';
import type { MongoDoc, TakeResult, BitmexAction } from '../../types';

/**
 * announcement — WS-origin.
 *
 * Platform announcements (rare, mostly during market events). Republished as-is.
 */
export const announcementHandler: TableHandler = {
  collection: 'announcement',
  origin:     'ws',
  partial:    null,

  getTimestamp: timestampFromData,

  take(docs: MongoDoc[]): TakeResult | null {
    if (docs.length === 0) return null;

    const doc = docs[0];

    return {
      messages: [{
        table:     'announcement',
        action:    doc.action as BitmexAction,
        timestamp: timestampFromData(doc),
        payload:   wsPayload('announcement', doc),
      }],
      consumed: 1,
    };
  },
};
