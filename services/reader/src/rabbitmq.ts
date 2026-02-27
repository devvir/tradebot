import { keepAlive, Broker } from '@devvir/rabbitmq';
import { logger } from '@devvir/service';
import type { Config } from './types';

/**
 * Creates and configures a RabbitMQ broker.
 */
export const connectToQueue = async (config: Config): Promise<Broker> => {
  logger.info('Setting up RabbitMQ broker...');
  const broker = await keepAlive(config.rabbitmqUrl);
  logger.info('Successfully connected to RabbitMQ');

  return broker.declares({
    exchanges: {
      [config.exchangeName]: {
        type: 'topic',
        queues: { [config.queueName]: { routingKey: '#' } },
      },
    },
  });
};

/**
 * Publish a document to the configured exchange (routingKey := collection name).
 */
export const publishDocument = async (
  broker: Broker,
  collectionName: string,
  document: Record<string, unknown>,
  config: Config
): Promise<void> => {
  const exchange = broker.getExchange(config.exchangeName);
  if (! exchange) throw new Error(`Exchange "${config.exchangeName}" not found`);

  await exchange.publishAsync(document, collectionName, {
    headers: { table: collectionName },
  });
};
