import { keepAlive, Broker } from '@devvir/rabbitmq';
import { logger } from '@devvir/service';

export const EXCHANGE = 'reader';

/**
 * Create and configure a RabbitMQ broker.
 * Declares a topic exchange for message publishing.
 * Queues are NOT declared here — downstream consumers assert their own.
 */
export const connectToQueue = async (rabbitmqUrl: string): Promise<Broker> => {
  logger.info('Setting up RabbitMQ broker...');

  const broker = await keepAlive(rabbitmqUrl);

  return broker.declares({
    exchanges: {
      [EXCHANGE]: { type: 'topic' },
    },
  });
};
