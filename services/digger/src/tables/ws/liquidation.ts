import type { TableHandler } from '../handler';
import { timestampFromId, wsPayload } from '../handler';
import type { MongoDoc, TakeResult, BitmexAction } from '../../types';

/**
 * liquidation — WS-origin.
 *
 * insert / update / delete. LiquidationData has no `timestamp` field, so the
 * day-granularity decode of `_id` is the only ordering signal available. Good
 * enough — liquidations are sparse and exact sub-day position rarely matters
 * for cross-table merge fidelity.
 */
export const liquidationHandler: TableHandler = {
  collection: 'liquidation',
  origin:     'ws',
  partial:    null,

  getTimestamp: timestampFromId,

  take(docs: MongoDoc[]): TakeResult | null {
    if (docs.length === 0) return null;

    const doc = docs[0];

    return {
      messages: [{
        table:     'liquidation',
        action:    doc.action as BitmexAction,
        timestamp: timestampFromId(doc),
        payload:   wsPayload('liquidation', doc),
      }],
      consumed: 1,
    };
  },
};
