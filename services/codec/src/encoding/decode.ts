import { brotliDecompress } from 'node:zlib';
import { promisify } from 'node:util';
import type { RawMessage } from '@devvir/rabbitmq';
import type { BitmexTable } from '@tradebot/types';
import { logger } from '@devvir/service';
import { decodeMessage } from './decoders';
import { unpackDocumentId } from './document-id';
import { bigIntToBuffer } from './utils';
import type { DecodedMessage, UnknownMessage } from './types';

const brotliDecompressAsync = promisify(brotliDecompress);

/**
 * Decode a MongoDB document back to a BitmexDataMessage.
 *
 * Incoming message is always a parsed JS object (the broker JSON-parses all
 * messages). The document was written by the writer service and its shape
 * depends on which codec strategy produced it:
 *
 *   binary (± encode) → { _id: "<Long decimal>", b: "<base64>" }
 *   encode only       → { _id: "<Long decimal>", [symbol]: encodedItems[], ... }
 *   raw / passthru    → { _id: "<ObjectId hex>", table, action, data: [...] }
 *
 * The codec makes no assumptions about which strategy was used: it inspects the
 * document and handles all three cases, guaranteeing a decoded BitmexDataMessage
 * as output regardless of input.
 */
export default async (rawMsg: RawMessage, message: unknown): Promise<DecodedMessage | null> => {
  const doc = (typeof message === 'string' ? JSON.parse(message) : message) as UnknownMessage;
  const table = rawMsg.fields.routingKey.split('.')[1] as BitmexTable;
  const format = detectFormat(doc);

  try {
    // Raw: document is already the original BitmexDataMessage shape
    if (format === 'raw') return doc;

    const idBuffer = idToBuffer(doc._id);
    if (! idBuffer) {
      logger.error({ table, id: doc._id }, 'Cannot parse document _id as numeric');
      return null;
    }

    if (format === 'binary') {
      // doc.b is a base64 string (BSON Binary.toJSON())
      const compressed = Buffer.from(String(doc.b), 'base64');
      const decompressed = JSON.parse((await brotliDecompressAsync(compressed)).toString());

      if (Array.isArray(decompressed)) {
        // binary-only (no encode): decompressed is the raw data[], action from _id
        const { action } = unpackDocumentId(idBuffer);

        return { table, action, data: decompressed };
      }

      // encode+binary: decompressed is the encoded record, decode normally
      return decodeMessage(table, decompressed, idBuffer);
    }

    return decodeMessage(table, extractPayload(doc), idBuffer);
  } catch (err) {
    logger.error({ err, table, format }, 'Failed to decode message');
    return null;
  }
};

/** Check whether id is a BSON Long serialised as { high, low } via JSON. */
const isBsonLong = (id: unknown): id is { high: number; low: number } =>
  typeof id === 'object' && id !== null &&
  typeof (id as any).high === 'number' && typeof (id as any).low === 'number';

/** Reconstruct a BigInt from a BSON Long's high/low 32-bit halves. */
const longToBigInt = (id: { high: number; low: number }): bigint =>
  (BigInt(id.high) << 32n) | (BigInt(id.low) & 0xffffffffn);

/** Convert a numeric _id (string, number, or BSON Long object) to an 8-byte BE Buffer. */
const idToBuffer = (id: unknown): Buffer | null => {
  try {
    return bigIntToBuffer(isBsonLong(id) ? longToBigInt(id) : BigInt(String(id)));
  } catch {
    return null;
  }
};

/** Codec-generated _ids are numeric Longs; auto-generated ObjectIds are 24-char hex strings. */
const isNumericId = (id: unknown): boolean =>
  isBsonLong(id) || /^\d+$/.test(String(id));

/** Strip _id (and b for binary docs) so only the encoded payload fields remain. */
const extractPayload = (doc: UnknownMessage): Record<string, unknown[]> => {
  const { _id, ...rest } = doc;
  return rest as Record<string, unknown[]>;
};

/**
 * Detect the storage format of a MongoDB document produced by the writer.
 *
 * - `binary`  → doc has a `b` field (Brotli-compressed content, base64 string)
 * - `encoded` → numeric _id packed by the codec encoder (no `b` field)
 * - `raw`     → auto-generated ObjectId; document is the original BitmexDataMessage
 */
const detectFormat = (doc: UnknownMessage): 'binary' | 'encoded' | 'raw' => {
  if ('b' in doc) return 'binary';
  if (isNumericId(doc._id)) return 'encoded';
  return 'raw';
};
