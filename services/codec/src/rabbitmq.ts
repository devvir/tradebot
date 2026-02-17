import { keepAlive, Broker } from '../../../packages/rabbitmq';
import logger from './logger';

/**
 * Creates and configures a RabbitMQ broker for the codec service.
 * Sets up the necessary topology: bitmex-data exchange, bitmex-feed queue, and archivist queue.
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
    exchanges: {
      'bitmex-data': {
        type: 'topic',
        durable: true,
        queues: {
          'bitmex-feed': {
            routingKey: '#',
            durable: true,
          },
        },
      },
    },
    queues: {
      'archivist': {
        durable: true,
      },
    },
  });

  logger.info('RabbitMQ topology declared');

  return broker;
};
