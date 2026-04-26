import type { TableHandler } from '../handler';
import { timestampFromData, wsPayload } from '../handler';
import type { MongoDoc, TakeResult, BitmexAction } from '../../types';

/**
 * instrument — WS-origin.
 *
 * Stored by registrar as complete WS messages. Republish by stripping `_id`
 * and injecting `table` back (not stored in MongoDB).
 * Partials carry keys/types/filter from TABLE_SPECS.
 */
export const instrumentHandler: TableHandler = {
  collection: 'instrument',
  origin:     'ws',
  partial:    null,

  getTimestamp: timestampFromData,

  take(docs: MongoDoc[]): TakeResult | null {
    if (docs.length === 0) return null;

    const doc = docs[0];

    return {
      messages: [{
        table:     'instrument',
        action:    doc.action as BitmexAction,
        timestamp: timestampFromData(doc),
        payload:   wsPayload('instrument', doc),
      }],
      consumed: 1,
    };
  },
};
