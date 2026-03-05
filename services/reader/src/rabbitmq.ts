import { keepAlive, Broker } from '@devvir/rabbitmq';
import { logger } from '@devvir/service';
import type { Config } from './types';

/**
 * Create and configure a RabbitMQ broker.
 *
 * Declares a durable queue `reader.<database>` on the default exchange.
 * Each pipeline gets its own isolated queue keyed by the database name.
 */
export const connectToQueue = async (
  { rabbitmqUrl: url, database }: Config,
): Promise<Broker> => {
  logger.info('Setting up RabbitMQ broker...');

  const broker = await keepAlive(url);

  return broker.declares({
    queues: {
      [`reader.${database}`]: {},
    },
  });
};
