// Pending Review
import type { BitmexAction } from '@tradebot/types';
import { pack, bigIntToBuffer, encodeVersion, decodeVersion, encodeTimestamp, decodeTimestamp, extractBig } from './utils';
import { ACTION_ID } from './mappings';

/**
 * Document _id bit layout (MSB → LSB, 64 bits total):
 *   unused(2) | timestamp(42) | apiVersion(9) | encoderVersion(9) | action(2)
 */

const ACTION_MAP: Record<number, BitmexAction> = { 0: 'partial', 1: 'insert', 2: 'update', 3: 'delete' };

// ── Build ──────────────────────────────────────────────────────────────────────

/**
 * Pack message metadata into a single 64-bit document _id.
 */
export const buildDocumentId = (
  timestamp: string,
  action: BitmexAction,
  apiVersion = '2.0.0',
  encoderVersion = '1.0.0',
): bigint =>
  pack([
    { number: 0, bits: 2 },
    encodeTimestamp(timestamp),
    encodeVersion(apiVersion),
    encodeVersion(encoderVersion),
    { number: ACTION_ID[action], bits: 2 },
  ]);

/** Convenience: pack and serialise as an 8-byte big-endian Buffer. */
export const buildDocumentIdBuffer = (
  timestamp: string,
  action: BitmexAction,
  apiVersion = '2.0.0',
  encoderVersion = '1.0.0',
): Buffer => bigIntToBuffer(buildDocumentId(timestamp, action, apiVersion, encoderVersion));

// ── Unpack ─────────────────────────────────────────────────────────────────────

/**
 * Extract action, encoder version, and timestamp from an 8-byte _id buffer.
 */
export const unpackDocumentId = (idBuffer: Buffer | ArrayBuffer) => {
  const id = (Buffer.isBuffer(idBuffer) ? idBuffer : Buffer.from(idBuffer)).readBigUInt64BE();

  return {
    action: ACTION_MAP[Number(id & 0x3n)] || 'partial',
    encoderVersion: decodeVersion(extractBig(id, 2, 9)),
    timestamp: decodeTimestamp(extractBig(id, 20, 42)),
  };
};
