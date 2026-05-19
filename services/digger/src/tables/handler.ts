import type {
  BitmexTable,
  BitmexAction,
  BitmexFieldType,
  WsMessage,
  MongoDoc,
  TakeResult,
} from '../types';

// ── TableHandler interface ────────────────────────────────────────────────────

/**
 * A TableHandler encapsulates everything digger needs to know about one BitMEX table:
 *
 *   ws-origin   docs are stored WS messages — strip `_id`, republish as-is.
 *               partials come naturally from the stream.
 *
 *   rest-origin docs are flat data records — wrap each as a single insert.
 *               static empty partial (schema only) on subscribe.
 */
export interface TableHandler {
  /** MongoDB collection name. Matches the BitMEX table name. */
  collection: BitmexTable;

  /** Determines storage shape and re-emit strategy. */
  origin: 'ws' | 'rest';

  /**
   * Static partial sent on subscribe when the snapshots accumulator is cold.
   *
   *   ws-origin   null — the stored stream contains the real partial.
   *   rest-origin a hardcoded empty partial carrying only the schema.
   */
  partial: WsMessage | null;

  /** Epoch-ms timestamp of a raw doc. Used for k-way merge ordering. */
  getTimestamp(doc: MongoDoc): number;

  /**
   * Consume the next logical WS message from the head of the buffer.
   *
   * Most handlers: consumed=1, one message per doc.
   * trade:         consumed=N, sweep reconstruction groups same-timestamp+symbol docs.
   */
  take(docs: MongoDoc[]): TakeResult | null;
}

// ── Partial helpers ───────────────────────────────────────────────────────────

/**
 * Build the static empty partial (schema only) emitted by REST-origin handlers
 * on subscribe. Field types come straight from each handler's schema declaration.
 */
export const makeEmptyPartial = (
  table:        BitmexTable,
  keys:         string[],
  types:        Record<string, BitmexFieldType>,
  foreignKeys?: Record<string, string>,
  attributes?:  Record<string, string>,
  filter?:      Record<string, unknown>,
): WsMessage => ({
  table,
  action: 'partial' as BitmexAction,
  keys,
  types,
  ...(foreignKeys ? { foreignKeys } : {}),
  ...(attributes  ? { attributes  } : {}),
  ...(filter      ? { filter      } : {}),
  data: [],
});

// ── Timestamp helpers ─────────────────────────────────────────────────────────

const EPOCH_2000_MS = Date.UTC(2000, 0, 1);
const MS_PER_DAY    = 86_400_000;
const SHIFT_39      = 549_755_813_888;

/**
 * Decode the day-granularity timestamp encoded in the numeric `_id`.
 * `_id = dateOffset × 2^39 + msgIndex × 2^12` (see farmer/src/write/id.ts).
 */
export const timestampFromId = (doc: MongoDoc): number =>
  Math.floor(doc._id / SHIFT_39) * MS_PER_DAY + EPOCH_2000_MS;

/**
 * For WS-origin tables that carry a `timestamp` field on their data items —
 * use that, fall back to the `_id` decode when absent (cheap defence).
 */
export const timestampFromData = (doc: MongoDoc): number => {
  const data = doc.data as Array<Record<string, unknown>> | undefined;
  const ts   = data?.[0]?.timestamp as string | undefined;

  return ts ? new Date(ts).getTime() : timestampFromId(doc);
};

/** Pluck the `timestamp` field directly from a flat REST-origin record. */
export const timestampFromField = (doc: MongoDoc): number =>
  new Date(doc.timestamp as string).getTime();

// ── WS-origin helpers ─────────────────────────────────────────────────────────

/**
 * Build the republish payload for a WS-origin document.
 *
 * MongoDB stores WS messages without the `table` field (it is inferred from
 * the collection name). Strip `_id` and inject `table` back so consumers
 * receive the same shape that broadcast publishes from live BitMEX messages.
 */
export const wsPayload = (table: BitmexTable, doc: MongoDoc): WsMessage => {
  const { _id: _, ...rest } = doc;

  return { table, ...rest } as unknown as WsMessage;
};

// ── REST-origin helpers ───────────────────────────────────────────────────────

/**
 * Wrap a single flat REST-origin record as a one-item `insert` message.
 * Used by every simple REST-origin handler — trade is the only exception
 * (sweep reconstruction lives in trade.ts).
 */
export const wrapAsInsert = (table: BitmexTable, doc: MongoDoc): TakeResult => {
  const { _id: _, ...item } = doc;

  return {
    messages: [{
      table,
      action:    'insert',
      timestamp: timestampFromField(doc),
      payload:   { table, action: 'insert', data: [item] },
    }],
    consumed: 1,
  };
};
