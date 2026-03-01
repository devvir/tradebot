import type { RawMessage } from '@devvir/rabbitmq';
import type { BitmexDataMessage } from '@tradebot/types';
import { encode, decode, type Strategy, type DecodedMessage, type EncodedMessage } from '.';
import { BSON } from 'bson';

/**
 * Apply the configured codec strategy to an inbound message.
 */
export default async (rawMsg: RawMessage, jsonMsg: EncodedMessage | DecodedMessage): Promise<Buffer> => {
  const strategy = rawMsg.fields.routingKey.split('.')[0] as Strategy;

  const newMessage = await applyStrategy(strategy, rawMsg, jsonMsg);
  if (! newMessage) throw new Error('Transform failed, nacking message');

  return Buffer.from(BSON.serialize(newMessage as Record<string, unknown>));
};

const applyStrategy = async (
  strategy: Strategy,
  rawMsg: RawMessage,
  jsonMsg: EncodedMessage | DecodedMessage,
): Promise<EncodedMessage | DecodedMessage | null> => {
  if (strategy === 'decode') return decode(rawMsg, jsonMsg);

  if (! jsonMsg || (typeof jsonMsg !== 'object' || !('data' in jsonMsg))) {
    throw new Error('Invalid message format, cannot encode');
  }

  return encode(strategy, rawMsg, jsonMsg as unknown as BitmexDataMessage);
};