import { logger } from '@devvir/service';
import type { RawMessage } from '@devvir/rabbitmq';
import { getIdempotentId } from './documentId';
import { encode, decode, type Strategy, type DecodedMessage, type EncodedMessage, type BitmexDataMessage } from '.';

/**
 * Apply the configured codec strategy to an inbound message, then ensure an
 * idempotent _id for deduplication on insert.
 *
 * This is the ONLY place that manages _id. Strategies must NOT set _id.
 */
export default (rawMsg: RawMessage, jsonMsg: EncodedMessage | DecodedMessage): Buffer => {
  const strategy = rawMsg.fields.routingKey.split('.')[0] as Strategy;

  logger.debug({ strategy, routingKey: rawMsg.fields.routingKey }, 'Transform called with strategy');

  const payload = applyStrategy(strategy, rawMsg, jsonMsg);
  if (! payload) throw new Error('Transform failed, nacking message');

  payload._id = getIdempotentId(jsonMsg as Record<string, unknown>, payload, rawMsg);

  return Buffer.from(JSON.stringify(payload));
};

const applyStrategy = (
  strategy: Strategy,
  rawMsg: RawMessage,
  jsonMsg: EncodedMessage | DecodedMessage,
): Record<string, unknown> | null => {
  if (strategy === 'passthru') return jsonMsg;
  if (strategy === 'decode') return decode(rawMsg, jsonMsg);

  return encode(strategy, rawMsg, jsonMsg as unknown as BitmexDataMessage);
};