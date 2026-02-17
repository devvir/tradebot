import { keepAlive, Broker } from '../../../packages/rabbitmq';
import logger from './logger';

/**
 * Creates and configures a RabbitMQ broker for the archivist service.
 * Sets up the necessary topology: archivist queue for consuming messages.
 *
 * Connection lifecycle events (connect/disconnect/reconnect/errors) are logged
 * by the broker, so the service doesn't need to handle them.
 */
export const connectRabbitMQ = async (url: string): Promise<Broker> => {
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
