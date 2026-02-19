import { brotliCompressSync } from 'node:zlib';
import type { BitmexWSMessage } from '../../../shared/types';
import type { RawMessage } from '../../../packages/rabbitmq';
import { type EncodedField, ACTION_ID, encodeVersion, encodeTimestamp, extractPayload, } from './encoding/mappings';
import { codecStrategy } from './config';

interface EncodedMessage {
  headers: Record<string, unknown>;
  payload: Buffer | Record<string, unknown>[];
}

/**
 * Encode a raw AMQP message for compressed archival.
 *
 * Responsibilities:
 * - Build outbound headers (table for collection routing, metadata for document fields)
 * - Strip redundant payload fields (table, keys, types, filter)
 * - Encode action as a compact 1-byte prefix
 * - Brotli-compress data items
 *
 * Returns headers and the compressed payload buffer.
 */
export const encode = (rawMsg: RawMessage, jsonMsg: BitmexWSMessage): EncodedMessage => {
  const [table, _] = rawMsg.fields.routingKey.split('.');

  let payload = jsonMsg.data as unknown;

  if (codecStrategy.trim() || codecStrategy.pack()) {
    payload = extractPayload(jsonMsg.data, table, jsonMsg.action);
  }

  if (codecStrategy.binary()) {
    payload = brotliCompressSync(JSON.stringify(payload));
  }

  return {
    headers: messageHeaders(rawMsg, jsonMsg),
    payload: payload as EncodedMessage['payload'],
  };
};

/**
 * Pack multiple encoded fields into a single BigInt.
 * Fields are packed MSB first: first field occupies the highest bits.
 *
 * @param fields Array of { encoded, bits } objects to pack
 * @returns Packed BigInt combining all fields
 * @throws Error if total bits exceed 64
 */
const pack = (fields: EncodedField[]): bigint => {
  let totalBits = 0;
  let packed = 0n;

  for (const field of fields) {
    if (totalBits + field.bits > 64) {
      throw new Error(`Cannot pack: total bits ${totalBits + field.bits} exceeds 64`);
    }

    // Shift the current value left by the number of bits for this field,
    // then add the new encoded value
    packed = (packed << BigInt(field.bits)) | BigInt(field.encoded);
    totalBits += field.bits;
  }

  return packed;
};

const extractTs = (message: BitmexWSMessage): string => {
  return (message.data.length && 'timestamp' in message.data[0])
    ? message.data[0].timestamp
    : new Date().toISOString();
};

const messageHeaders = (rawMsg: RawMessage, jsonMsg: BitmexWSMessage): Record<string, unknown> => {
  const [table, symbol] = rawMsg.fields.routingKey.split('.');
  const documentId = createDocumentId(rawMsg, jsonMsg);

  return {
    table,
    metadata: {
      _id: bigIntToBuffer(documentId),
      ...(symbol && { s: symbol }),
    },
  };
}

/**
 * Create custom MongoDB _id by packing message metadata into a single int64.
 */
const createDocumentId = (message: RawMessage, jsonMsg: BitmexWSMessage, encoderVersion: string = '1.0.0'): bigint => {
  const actionId = ACTION_ID[jsonMsg.action as keyof typeof ACTION_ID];
  const apiVersion = message.properties.headers?.api_version as string | undefined;

  return pack([
    { encoded: 0, bits: 2 },                // unused (2 bits, 62-63)
    encodeTimestamp(extractTs(jsonMsg)),    // timestamp (42 bits, 20-61)
    encodeVersion(apiVersion || '2.0.0'),   // apiVersion (9 bits, 11-19)
    encodeVersion(encoderVersion),          // encoderVersion (9 bits, 2-10)
    { encoded: actionId, bits: 2 },         // action (2 bits, 0-1)
  ]);
};

/**
 * Serialise a BigInt as a big-endian 8-byte Buffer for lossless AMQP header transport.
 */
const bigIntToBuffer = (value: bigint): Buffer => {
  const buf = Buffer.allocUnsafe(8);
  buf.writeBigUInt64BE(value);
  return buf;
};
