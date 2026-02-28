import { keepAlive, Broker } from '@devvir/rabbitmq';
import { logger } from '@devvir/service';
import { type Config, CONSUMER_QUEUES, DLQ, DLX, EXCHANGE } from './types';

/**
 * Creates and configures a RabbitMQ broker.
 * Declares the writer topic exchange with archive, collect, and custom queues.
 */
export const connectToQueue = async (config: Config): Promise<Broker> => {
  logger.info('Setting up RabbitMQ broker...');

  const broker = await keepAlive(config.rabbitmqUrl);

  return broker.declares({
    exchanges: {
      [EXCHANGE]: {
        type: 'topic',
        queues: {
          [CONSUMER_QUEUES.archive]: { routingKey: 'archive.*', deadLetterExchange: DLX },
          [CONSUMER_QUEUES.collect]: { routingKey: 'collect.*', deadLetterExchange: DLX },
          [CONSUMER_QUEUES.custom]:  { routingKey: 'custom.*.*', deadLetterExchange: DLX },
        },
      },

      /** Dead-letter exchange */
      [DLX]: { type: 'fanout', queues: { [DLQ]: {} } },
    },
  });
};
