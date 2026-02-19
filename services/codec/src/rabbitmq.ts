import { keepAlive, Broker } from '../../../packages/rabbitmq';
import { BitmexWSMessage } from '../../../shared/types/src';
import { codecStrategy } from './config';
import logger from './logger';
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
            const headers = { table: rawMsg.fields.routingKey.split('.')[0] };

            outputQueue.publish(message, { headers, contentType: 'application/json' });
          } else {
            const { headers, payload } = encode(rawMsg, message as BitmexWSMessage);
            const contentType = codecStrategy.binary() ? 'application/octet-stream' : 'application/json';

            outputQueue.publish(payload, { headers, contentType });
          }

          onPublishMsg();
          ack();
        } catch (error) {
          logger.error({ error }, 'Error processing message');
          nack(true);
        }
      }, { prefetch: 10 }
    );

    logger.info('Started consuming messages');
  } catch (e) {
    logger.error({ e }, 'Failed to start consuming');
    throw e;
  }
};
