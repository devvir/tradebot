import { keepAlive, Broker } from '@devvir/rabbitmq';
import { BitmexDataMessage } from '@tradebot/types';
import { codecStrategies, codecStrategy } from './config';
import logger from '@tradebot/logger';
import { encode } from './transform';

const consumerQueueName = 'bitmex-feed';
const outputQueueName = 'archivist';

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

  return broker.declares({
    queues: { 'archivist': {} }, // Default exchange
    exchanges: {
      'bitmex-data': {
        type: 'topic',
        queues: { 'bitmex-feed': { routingKey: '#' } },
      },
    }
  });
};

export const startConsuming = async (
  broker: Broker,
  onProcessMsg: () => void,
  onPublishMsg: () => void
): Promise<void> => {
  try {
    const inputQueue = broker.getQueue(consumerQueueName)!;
    const outputQueue = broker.getQueue(outputQueueName)!;

    logger.info({ queue: consumerQueueName }, 'Starting message consumption');

    await inputQueue.consume(
      async (message, { ack, nack, original: rawMsg }) => {
        if (! message) return;

        try {
          onProcessMsg();

          if (codecStrategy.passthru()) {
            outputQueue.publish(message, {
              headers: { table: rawMsg.fields.routingKey.split('.')[0] },
              contentType: 'application/json',
            });
          } else {
            const { headers, payload } = encode(rawMsg, message as BitmexDataMessage);
            const contentType = codecStrategy.binary() ? 'application/octet-stream' : 'application/json';

            outputQueue.publish(payload, { headers, contentType });
          }

          onPublishMsg();
          ack();
        } catch (e) {
          const error = e instanceof Error ? e.message : e;
          logger.error({ error, codecStrategies, message }, 'PINO: Error processing feed message');
          nack(true);
        }
      }, { prefetch: 10 }
    );

    logger.info('Started consuming messages');
  } catch (error) {
    logger.error({ error }, 'Failed to start consuming');
    throw error;
  }
};
