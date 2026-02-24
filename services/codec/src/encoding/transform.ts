import { brotliCompressSync, constants } from 'node:zlib';
import type { RawMessage } from '@devvir/rabbitmq';
import type { BitmexDataMessage } from '@tradebot/types';
import type { EncodedMessage } from './types';
import { codecStrategy } from '../config';
import { encodePayload } from './encoders';
import { buildDocumentId } from './document-id';
import { bigIntToBuffer } from './utils';
import { logger } from '@devvir/service';

const BROTLI_QUALITY = parseInt(process.env.CODEC_BROTLI_QUALITY || '4', 10);

/**
 * Encode a raw AMQP message for compressed archival.
 *
 * - Build outbound headers (table for collection routing, metadata for document fields)
 * - Strip redundant payload fields (table, keys, types, filter)
 * - Encode action as a compact 1-byte prefix
 * - Brotli-compress data items
 *
 * Returns headers and the compressed payload (binary buffer or encoded JSON object).
 */
export const encode = (rawMsg: RawMessage, jsonMsg: BitmexDataMessage): EncodedMessage => {
  const table = rawMsg.fields.routingKey;

  let payload = jsonMsg.data as unknown;
  let headers: Record<string, unknown> = {};

  try {
    headers = messageHeaders(rawMsg, jsonMsg);

    if (codecStrategy.encode()) {   // Reduce size by encoding, pruning and packing
      payload = encodePayload(jsonMsg.data, table, jsonMsg.action);
    }
  } catch (err) {
    logger.error(
      { err, table, action: jsonMsg.action, data: jsonMsg.data[0] ?? null },
      'Failed to encode message, falling back to raw payload'
    );

    payload = jsonMsg.data;
  }

  if (codecStrategy.binary()) { // Compress full document (binary output)
    payload = brotliCompressSync(JSON.stringify(payload), {
      params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
    });
  }

  return {
    headers,
    payload: payload as EncodedMessage['payload'],
  };
};

const messageHeaders = (rawMsg: RawMessage, jsonMsg: BitmexDataMessage): Record<string, unknown> => {
  const apiVersion = rawMsg.properties.headers?.api_version as string | undefined;
  const documentId = buildDocumentId(extractTs(jsonMsg), jsonMsg.action, apiVersion || '2.0.0');

  return { metadata: { _id: bigIntToBuffer(documentId) } };
};

const extractTs = (message: BitmexDataMessage): string => {
  return (message.data.length && 'timestamp' in message.data[0])
    ? message.data[0].timestamp
    : new Date().toISOString();
};
