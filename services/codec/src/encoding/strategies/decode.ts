import { brotliDecompressSync } from 'node:zlib';
import { logger } from '@devvir/service';
import { type RawMessage } from '@devvir/rabbitmq';
import { type BitmexTable } from '@tradebot/types';
import { decodeMessage, type DecodedMessage, type UnknownMessage } from '..';

/**
 * Decode a MongoDB document back to a BitmexDataMessage.
 *
 * Incoming message is always a parsed JS object (the broker JSON-parses all
 * messages).
 *
 *   compress (± encode) → { _id: number, b: "<base64>" }
 *   encode only         → { _id: number, [symbol]: encodedItems[], ... }
 *   raw / passthru      → { _id: number, table, action, data: [...] }
 *
 * The codec makes no assumptions about which strategy was used: it inspects the
 * document and handles all three cases, guaranteeing a decoded BitmexDataMessage
 * as output regardless of input.
 *
 * _id handling (preservation/generation) is done by transform.ts.
 */
export default (rawMsg: RawMessage, message: unknown): DecodedMessage | null => {
  const doc = (typeof message === 'string' ? JSON.parse(message) : message) as UnknownMessage;
  const table = rawMsg.fields.routingKey.split('.')[1] as BitmexTable;
  const format = detectFormat(doc);

  logger.debug({ incomingId: JSON.stringify(doc._id), format, table }, 'Decode strategy called');

  try {
    if (format === 'raw') return doc;

    if (format === 'compressed') {
      // doc.b arrives as a base64 string: MongoDB BSON Binary serialises to
      // base64 when JSON-stringified for RabbitMQ transport.
      const compressed = Buffer.from(doc.b as string, 'base64');
      const decompressed = JSON.parse(brotliDecompressSync(compressed).toString());

      return decodeMessage(table, decompressed, doc._id as number);
    }

    return decodeMessage(table, extractPayload(doc), doc._id as number);
  } catch (err) {
    logger.error({ err, table, format }, 'Failed to decode message');
    return null;
  }
};

/** Strip _id (and b for compressed docs) so only the encoded payload fields remain. */
const extractPayload = (doc: UnknownMessage): Record<string, unknown[]> => {
  const { _id, ...rest } = doc;
  return rest as Record<string, unknown[]>;
};

/**
 * Detect the storage format of a MongoDB document produced by the writer.
 *
 * - `compressed` → doc has a `b` field (Brotli-compressed content, base64 string)
 * - `encoded`    → numeric _id packed by the codec encoder (no `b` field)
 * - `raw`        → auto-generated ObjectId; document is the original BitmexDataMessage
 */
const detectFormat = (doc: UnknownMessage): 'compressed' | 'encoded' | 'raw' => {
  if ('action' in doc && typeof doc.action === 'string') return 'raw';
  if ('b' in doc && ! Array.isArray(doc.b)) return 'compressed';
  return 'encoded';
};
