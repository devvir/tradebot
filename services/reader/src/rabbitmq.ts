import { keepAlive, Broker } from '@devvir/rabbitmq';
import amqp from 'amqplib';
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
  const channel = broker.getChannel();

  if (! channel) throw new Error('No RabbitMQ channel available');

  const message = Buffer.from(JSON.stringify(document));

  const published = channel.publish(
    config.exchangeName,
    collectionName,
    message,
    {
      contentType: 'application/json',
      persistent: true,
      headers: { table: collectionName },
    } as amqp.Options.Publish
  );

  if (! published) throw new Error(`Failed to publish to ${config.exchangeName}/${collectionName}`);
};
