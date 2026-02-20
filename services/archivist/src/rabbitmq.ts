import { keepAlive, Broker } from '@devvir/rabbitmq';
import logger from '@tradebot/logger';

/**
 * Creates and configures a RabbitMQ broker.
 * Sets up the necessary message topology for this service.
 *
 * Connection lifecycle events are logged by the broker.
 */
export const connectToQueue = async (url: string): Promise<Broker> => {
  logger.info('Setting up RabbitMQ broker...');

  // Connect with unlimited retries (broker logs all connection events)
  const broker = await keepAlive(url);

  // Declare topology
  await broker.declares({
    queues: {
      'archivist': {
        durable: true,
      },
    },
  });

  logger.info('RabbitMQ topology declared');

  return broker;
};
