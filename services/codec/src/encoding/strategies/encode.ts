import { brotliCompressSync, constants } from 'node:zlib';
import { logger } from '@devvir/service';
import { type BitmexDataMessage } from '@tradebot/types';
import { type RawMessage } from '@devvir/rabbitmq';
import { encodePayload, type Strategy } from '..';

const BROTLI_QUALITY = parseInt(process.env.CODEC_BROTLI_QUALITY || '1');
const BROTLI_OPTIONS = { params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } };

/**
 * Encode a raw AMQP message for compressed archival.
 *
 * - Strip redundant payload fields (table, keys, types, filter)
 * - Encode action as a compact 1-byte prefix
 * - Brotli-compress data items (if compress mode)
 *
 * Returns the encoded payload. _id is handled by transform.ts.
 */
export default (strategy: Strategy, original: RawMessage, jsonMsg: BitmexDataMessage): Record<string, unknown> => {
  let payload = jsonMsg.data as unknown as Record<string, unknown>;

  try {
    // Reduce size by encoding, pruning and packing
    const table = original.fields.routingKey.split('.')[1];
    payload = encodePayload(jsonMsg.data, table, jsonMsg.action);

    // Further compress if so configured
    if (strategy === 'compress') {
      const compressed = brotliCompressSync(JSON.stringify(payload), BROTLI_OPTIONS);
      payload = { b: compressed };
    }
  } catch (err) {
    logger.error({ err, routingKey: original.fields.routingKey }, 'Failed to encode message, falling back to raw payload');
  }

  return payload;
};
