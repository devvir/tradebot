import { keepAlive, Broker } from '@devvir/rabbitmq';
import amqp from 'amqplib';
import { logger } from '@devvir/service';

const EXCHANGE_NAME = 'unarchived';
const OUTGOING_QUEUE = 'unarchived';

/**
 * Creates and configures a RabbitMQ broker.
 */
export const connectToQueue = async (url: string): Promise<Broker> => {
  logger.info('Setting up RabbitMQ broker...');
  const broker = await keepAlive(url);
  logger.info('Successfully connected to RabbitMQ');

  return broker.declares({
    exchanges: {
      [EXCHANGE_NAME]: {
        type: 'topic',
        queues: { [OUTGOING_QUEUE]: { routingKey: '#' } },
      },
    },
  });
};

/**
 * Publish a document to the unarchived exchange (routingKey := collection name).
 */
export const publishDocument = async (
  broker: Broker,
  collectionName: string,
  document: Record<string, unknown>
): Promise<void> => {
  const channel = broker.getChannel();

  if (! channel) throw new Error('No RabbitMQ channel available');

  const message = Buffer.from(JSON.stringify(document));

  const published = channel.publish(
    EXCHANGE_NAME,
    collectionName,
    message,
    {
      contentType: 'application/json',
      persistent: true,
      headers: { table: collectionName },
    } as amqp.Options.Publish
  );

  if (! published) throw new Error(`Failed to publish to ${EXCHANGE_NAME}/${collectionName}`);
};
