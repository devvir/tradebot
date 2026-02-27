// Pending Review
import type { RawMessage } from '@devvir/rabbitmq';
import type { BitmexDataMessage } from '@tradebot/types';
import { codecStrategy } from '../config';
import { encode } from './transform';
import { decode } from './decode';
import type { TransformResult } from './types';

/**
 * Apply the configured codec strategy to an inbound message.
 *
 * Returns a unified TransformResult with the payload, content type,
 * and optional headers ready for publishing — or null if decoding failed.
 */
export const transform = (rawMsg: RawMessage, message: unknown): TransformResult | null => {
  if (codecStrategy.passthru()) {
    return { payload: message, contentType: 'application/json' };
  }

  if (codecStrategy.decode()) {
    const decoded = decode(rawMsg, message);
    if (! decoded) return null;

    return { payload: decoded.payload, contentType: 'application/json' };
  }

  const { headers, payload } = encode(rawMsg, message as BitmexDataMessage);
  const contentType = codecStrategy.binary() ? 'application/octet-stream' : 'application/json';

  return { payload, contentType, headers };
};
