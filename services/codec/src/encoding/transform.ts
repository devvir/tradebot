import { RabbitMQ } from '@devvir/service-kit';
import { encode, decode, type Strategy, type BitmexDataMessage, type Message } from '.';

/**
 * Apply the configured codec strategy to an inbound message.
 */
export default (rawMsg: RabbitMQ.RawMessage, jsonMsg: Message): Buffer => {
  const headers = rawMsg.properties.headers ?? {};
  const strategy: Strategy = headers['x-codec-strategy'] || 'encode';

  const payload = strategy === 'encode'
    ? encode(jsonMsg as BitmexDataMessage)
    : decode(jsonMsg);

  if (! payload)
    throw new Error('Transform failed, nacking message');

  return Buffer.from(JSON.stringify(payload));
};
