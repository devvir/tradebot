import { logger, RabbitMQ } from '@devvir/service-kit';
import type { Config } from './types';

const BACKPRESSURE_POLL_MS = 2_000;

/**
 * Creates the per-document publish function used by the polling loop.
 *
 * Handles:
 * - Message encoding (bitmex envelope format)
 * - Backpressure: pauses publishing if the reader queue has reached
 *   READER_MAX_READY messages. Queue depth is polled in the background
 *   every BACKPRESSURE_POLL_MS to keep it off the hot publish path.
 */
export const createPublisher = (
  broker: RabbitMQ.Broker,
  config: Config,
): (collection: string, doc: Record<string, unknown>) => Promise<void> => {
  const queue = broker.getQueue()!;
  let messageCount = 0;
  let cachedDepth = 0;

  if (config.maxReady > 0) {
    const interval = setInterval(async () => {
      cachedDepth = await queue.getMessageCount();
    }, BACKPRESSURE_POLL_MS);

    interval.unref();
  }

  return async (collection, doc) => {
    if (config.maxReady > 0 && cachedDepth >= config.maxReady) {
      logger.debug({ depth: cachedDepth, limit: config.maxReady }, 'Reader paused: queue at capacity');

      while (cachedDepth >= config.maxReady) {
        await new Promise(r => setTimeout(r, 1000));
        cachedDepth = await queue.getMessageCount();
      }

      logger.debug({ depth: cachedDepth, limit: config.maxReady }, 'Reader resumed');
    }

    /** Action is encoded in the document id's LSB (2 bits) */
    const action = ['partial', 'insert', 'update', 'delete'][ Number(doc._id) % 4 ];
    const envelope = Buffer.from(JSON.stringify({ table: collection, action, ...doc }));

    await queue.publish(envelope, {
      contentType: 'application/json',
      headers: {
        'x-worker-uuid': config.workerUuid,
        'x-message-count': String(++messageCount),
      },
    });
  };
};
