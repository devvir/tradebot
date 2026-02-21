import { keepAlive, Broker } from '@devvir/rabbitmq';
import { logger } from '@devvir/service';

export const exchangeName = 'bitmex.feed';
export const queueName = 'bitmex.feed';

/**
 * Create and configure a RabbitMQ broker.
 *
 * Connection lifecycle events are logged by the broker.
 */
export const connectToQueue = async (url: string): Promise<Broker> => {
  logger.info('Setting up RabbitMQ broker...');

  const broker = await keepAlive(url);

  await broker.declares({
    exchanges: {
      [exchangeName]: {
        type: 'topic',
        queues: { [queueName]: { routingKey: '#' } },
      },
    },
  });

  return broker;
};
