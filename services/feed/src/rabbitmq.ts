import { keepAlive, Broker } from '@devvir/rabbitmq';
import { logger } from '@devvir/service';
import type { Config } from './types';

/**
 * Create and configure a RabbitMQ broker.
 *
 * Connection lifecycle events are logged by the broker.
 */
export const connectToQueue = async (config: Config): Promise<Broker> => {
  logger.info('Setting up RabbitMQ broker...');

  const broker = await keepAlive(config.queue.rabbitmqUrl);

  await broker.declares({
    exchanges: {
      [config.queue.exchangeName]: {
        type: 'topic',
        queues: { [config.queue.queueName]: { routingKey: '#' } },
      },
    },
  });

  return broker;
};
