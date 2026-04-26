import type { TableHandler } from '../handler';
import { timestampFromData, wsPayload } from '../handler';
import type { MongoDoc, TakeResult, BitmexAction } from '../../types';

/**
 * publicNotifications — WS-origin.
 *
 * Public alert messages from BitMEX (system status, settlement notices, …).
 * Republished as-is.
 */
export const publicNotificationsHandler: TableHandler = {
  collection: 'publicNotifications',
  origin:     'ws',
  partial:    null,

  getTimestamp: timestampFromData,

  take(docs: MongoDoc[]): TakeResult | null {
    if (docs.length === 0) return null;

    const doc = docs[0];

    return {
      messages: [{
        table:     'publicNotifications',
        action:    doc.action as BitmexAction,
        timestamp: timestampFromData(doc),
        payload:   wsPayload('publicNotifications', doc),
      }],
      consumed: 1,
    };
  },
};
