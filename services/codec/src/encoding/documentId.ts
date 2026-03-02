import type { BitmexAction } from '@tradebot/types';
import type { RawMessage } from '@devvir/rabbitmq';
import type { BitmexDataMessage } from '@tradebot/types';
import { pack, encodeVersion, decodeVersion, encodeTimestamp, decodeTimestamp, extract } from './utils';
import { ACTION_ID } from './mappings';
import { DecodedMessage, EncodedMessage } from './types';

/**
 * Document _id bit layout (MSB → LSB, 53 bits total):
 *   timestamp(42) | apiVersion(9) | action(2)
 *
 * Fits within Number.MAX_SAFE_INTEGER (2^53 - 1) so it can be used
 * as a plain number in JavaScript, MongoDB Compass, and mongosh.
 */

const ACTION_MAP: Record<number, BitmexAction> = { 0: 'partial', 1: 'insert', 2: 'update', 3: 'delete' };

// ── Build ──────────────────────────────────────────────────────────────────────

/**
 * Pack message metadata into a 53-bit document _id.
 * Returns a plain number (fits within Number.MAX_SAFE_INTEGER).
 */
export const buildDocumentId = (timestamp: string, action: BitmexAction, apiVersion = '2.0.0'): number =>
  pack([
    encodeTimestamp(timestamp),
    encodeVersion(apiVersion),
    { number: ACTION_ID[action], bits: 2 },
  ]);

// ── Unpack ─────────────────────────────────────────────────────────────────────

/**
 * Extract action, api version, and timestamp from a document _id.
 */
export const unpackDocumentId = (id: number) => ({
  action: ACTION_MAP[extract(id, 0, 2)] || 'partial',
  apiVersion: decodeVersion(extract(id, 2, 9)),
  timestamp: decodeTimestamp(extract(id, 11, 42)),
});

// ── Idempotent ID ──────────────────────────────────────────────────────────────

/**
 * Resolve the idempotent _id for a codec message as a plain number.
 *
 * Scans `incoming` and `payload` for an existing numeric _id (in that order).
 * If found, normalises it to number. Otherwise, generates a new one from
 * whichever object carries BitmexDataMessage fields (action, data).
 *
 * Called exclusively by transform.ts — the single place that sets _id.
 */
export const getIdempotentId = (
  incoming: EncodedMessage | DecodedMessage,
  payload: Record<string, unknown>,
  rawMsg: RawMessage,
): number => {
  // 1. Preserve an existing numeric _id (incoming takes precedence)
  const existingId = findNumericId(incoming) ?? findNumericId(payload);

  if (existingId) return existingId as number;

  // 2. Generate a new _id from message metadata
  const dataMsg = findDataMessage(payload, incoming);
  const apiVersion = rawMsg.properties.headers?.api_version as string | undefined;
  const ts = (dataMsg.data?.length && 'timestamp' in dataMsg.data[0])
    ? (dataMsg.data[0] as any).timestamp as string
    : new Date().toISOString();

  return buildDocumentId(ts, dataMsg.action, apiVersion || '2.0.0');
};

/** Return the _id if it's numeric, otherwise undefined. */
const findNumericId = (obj: Record<string, unknown>): unknown | undefined =>
  (obj && '_id' in obj && typeof obj._id === 'number' ? obj._id : undefined);

/** Pick whichever object has `action` (i.e. is a BitmexDataMessage). */
const findDataMessage = (...candidates: Record<string, unknown>[]): BitmexDataMessage => {
  const msg = candidates.find(o => o && 'action' in o);
  if (! msg) throw new Error('Cannot generate _id: no BitmexDataMessage found');

  return msg as unknown as BitmexDataMessage;
};
