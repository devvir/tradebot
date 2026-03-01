import { brotliCompress, constants } from 'node:zlib';
import { promisify } from 'node:util';
import { BSON } from 'bson';
import type { BitmexDataMessage } from '@tradebot/types';
import type { RawMessage } from '@devvir/rabbitmq';
import { logger } from '@devvir/service';
import { type EncodedMessage, type Strategy, encodePayload, buildDocumentId } from '.';

const DEFAULT_API_VERSION = '2.0.0';


const brotliCompressAsync = promisify(brotliCompress);

const BROTLI_QUALITY = parseInt(process.env.CODEC_BROTLI_QUALITY || '1');
const BROTLI_OPTIONS = { params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } };

/**
 * Encode a raw AMQP message for compressed archival.
 *
 * - Build document ID and embed as `_id` in the payload
 * - Strip redundant payload fields (table, keys, types, filter)
 * - Encode action as a compact 1-byte prefix
 * - Brotli-compress data items (if binary mode)
 *
 * Returns the payload (binary buffer or encoded JSON object) ready for archival.
 */
export default async (strategy: Strategy, original: RawMessage, jsonMsg: BitmexDataMessage): Promise<EncodedMessage> => {
  let payload = [ ...jsonMsg.data ] as unknown as Record<string, unknown>;

  try {
    // Reduce size by encoding, pruning and packing
    const table = original.fields.routingKey.split('.')[1];
    payload = encodePayload(jsonMsg.data, table, jsonMsg.action);

    // Further compress if so configured
    if (strategy === 'compress') {
      const compressed = await brotliCompressAsync(JSON.stringify(payload), BROTLI_OPTIONS);
      payload = { b: compressed };
    }
  } catch (err) {
    logger.error({ err }, 'Failed to encode message, falling back to raw payload');
  }

  return { _id: buildEncodedDocumentId(original, jsonMsg), ...payload };
};

const buildEncodedDocumentId = (original: RawMessage, jsonMsg: BitmexDataMessage): BSON.Long => {
  const apiVersion = original.properties.headers?.api_version as string | undefined;
  const documentId = buildDocumentId(extractTs(jsonMsg), jsonMsg.action, apiVersion || DEFAULT_API_VERSION);

  return BSON.Long.fromBigInt(documentId);
};

const extractTs = (message: BitmexDataMessage): string => {
  return (message.data.length && 'timestamp' in message.data[0])
    ? message.data[0].timestamp
    : new Date().toISOString();
};
