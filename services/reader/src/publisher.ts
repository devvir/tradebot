import { logger } from '@devvir/service';
import type { Broker } from '@devvir/rabbitmq';
import type { Config } from './types';

const BACKPRESSURE_CHECK_EVERY = 500;

/**
 * Creates the per-document publish function used by the polling loop.
 *
 * Handles:
 * - Message encoding (bitmex envelope format)
 * - Backpressure: pauses every BACKPRESSURE_CHECK_EVERY messages if the
 *   reader queue has reached READER_MAX_READY messages.
 */
export const createPublisher = (
  broker: Broker,
  config: Config,
): (collection: string, doc: Record<string, unknown>) => Promise<void> => {
  const queue = broker.getQueue()!;
  let publishCount = 0;

  return async (collection, doc) => {
    if (config.maxReady > 0 && ++publishCount % BACKPRESSURE_CHECK_EVERY === 0) {
      let depth = await queue.getMessageCount();

      if (depth >= config.maxReady) {
        logger.warn({ depth, limit: config.maxReady }, 'Reader paused: queue at capacity');

        while (depth >= config.maxReady) {
          await new Promise(r => setTimeout(r, 1000));
          depth = await queue.getMessageCount();
        }

        logger.info({ depth, limit: config.maxReady }, 'Reader resumed');
      }
    }

    /** Action is encoded in the document id's LSB (2 bits) */
    const action = ['partial', 'insert', 'update', 'delete'][ Number(doc._id) % 4 ];
    const envelope = Buffer.from(JSON.stringify({ table: collection, action, ...doc }));

    await queue.publish(envelope, { contentType: 'application/json' });
  };
};
