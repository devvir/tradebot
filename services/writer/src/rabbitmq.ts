import type { MongoClient } from 'mongodb';
import { logger } from '@devvir/service';
import { keepAlive, Broker } from '@devvir/rabbitmq';
import { type Config } from './types';
import { createBatchHandler } from './persistence';
import { pauseConsumer } from './documentId';

/** Writer exchange and queue names */
export const EXCHANGE = 'writer';
export const QUEUE = 'writer';
export const DLX = 'writer.dlx';
export const DLQ = 'writer.dead-letter';

/**
 * Creates and configures a RabbitMQ broker.
 */
export const connectToQueue = async (connectionUrl: string): Promise<Broker> => {
  const broker = await keepAlive(connectionUrl);

  return broker.declares({
    exchanges: {
      [EXCHANGE]: {
        type: 'topic',
        queues: {
          [QUEUE]: { routingKey: '#', deadLetterExchange: DLX },
        },
      },

      /** Dead-letter exchange */
      [DLX]: { type: 'fanout', queues: { [DLQ]: {} } },
    },
  });
};

/**
 * Start consuming from the writer queue.
 * Returns a drain function that cancels the consumer and flushes all pending
 * batches to MongoDB before returning — call this during graceful shutdown.
 */
export const startConsuming = async (
  broker: Broker,
  mongo: MongoClient,
  config: Config,
  onStoreMsg: () => void,
): Promise<() => Promise<void>> => {
  logger.debug({ queue: QUEUE }, 'Consuming from queue');

  const { handleMessage, drainAll } = createBatchHandler(mongo, config, QUEUE, onStoreMsg);

  const cancelConsumer = await broker.consume(QUEUE, async (_, delivery) => {
    const pause = pauseConsumer();
    if (pause) await pause;

    const { routingKey, properties } = delivery.metadata;
    const database = properties.headers?.['x-writer-database'] ?? 'tradebot';

    try {
      handleMessage(delivery, database);
    } catch (err) {
      logger.error({ err, routingKey }, 'Message rejected');
      delivery.nack(false);
    }
  }, { prefetch: config.prefetch });

  return async () => {
    await cancelConsumer();
    await drainAll();
  };
};
