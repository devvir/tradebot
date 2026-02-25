import { keepAlive, Broker } from '@devvir/rabbitmq';
import { logger } from '@devvir/service';
import type { Config } from './types';

/**
 * Creates and configures a RabbitMQ broker.
 * Sets up the necessary message topology for this service.
 *
 * Connection lifecycle events are logged by the broker.
 */
export const connectToQueue = async (config: Config): Promise<Broker> => {
  logger.info('Setting up RabbitMQ broker...');

  // Connect with unlimited retries (broker logs all connection events)
  const broker = await keepAlive(config.rabbitmqUrl);

  // Declare topology
  await broker.declares({
    exchanges: {
      [config.exchangeName]: {
        type: 'topic',
        queues: { [config.queueName]: { routingKey: '#' } },
      },
    },
  });

  logger.info('RabbitMQ topology declared');

  return broker;
};
