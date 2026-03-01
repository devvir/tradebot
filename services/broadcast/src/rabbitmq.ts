import { keepAlive, Broker } from '@devvir/rabbitmq';
import { logger } from '@devvir/service';
import type { Config } from './types';

export const EXCHANGE = 'broadcast';

/**
 * Create and configure a RabbitMQ broker.
 * Declares a topic exchange for message publishing.
 * Queues are NOT declared here — downstream consumers assert their own.
 */
export const connectToQueue = async (config: Config): Promise<Broker> => {
  logger.info('Setting up RabbitMQ broker...');

  const broker = await keepAlive(config.queue.rabbitmqUrl);

  return broker.declares({
    exchanges: {
      [EXCHANGE]: { type: 'topic' },
    },
  });
};
