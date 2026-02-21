import { logger } from '@devvir/service';
import { keepAlive, Broker } from '@devvir/rabbitmq';
import { BitmexDataMessage } from '@tradebot/types';
import { codecStrategies, codecStrategy } from './config';
import { encode } from './encoding';

const consumerQueueName = 'bitmex.feed';
const outputQueueName = 'archivist';

/**
 * Creates and configures a RabbitMQ broker.
 * Sets up the necessary message topology for this service.
 *
 * Connection lifecycle events are logged by the broker.
 */
export const connectToQueue = async (url: string): Promise<Broker> => {
  logger.info('Setting up RabbitMQ broker...');
  const broker = await keepAlive(url);
  logger.info('Successfully connected to RabbitMQ');

  broker.declares({
    queues: { [outputQueueName]: {} }, // Default exchange
    exchanges: {
      [consumerQueueName]: {
        type: 'topic',
        queues: { [consumerQueueName]: { routingKey: '#' } },
      },
    }
  });

  return broker;
};

export const startConsuming = async (broker: Broker, onProcessMsg: () => void): Promise<void> => {
  const inputQueue = await waitForQueue(broker, consumerQueueName);
  const outputQueue = broker.getQueue(outputQueueName)!;

  logger.info({ queue: consumerQueueName }, 'Starting message consumption');

  await inputQueue.consume(
    async (message, { ack, nack, original: rawMsg }) => {
      if (! message) return;

      try {
        onProcessMsg();

        if (codecStrategy.passthru()) {
          outputQueue.publish(message, {
            headers: { table: rawMsg.fields.routingKey },
            contentType: 'application/json',
          });
        } else {
          const { headers, payload } = encode(rawMsg, message as BitmexDataMessage);
          const contentType = codecStrategy.binary() ? 'application/octet-stream' : 'application/json';

          outputQueue.publish(payload, { headers, contentType });
        }

        ack();
      } catch (e) {
        const error = e instanceof Error ? e.message : e;
        logger.error({ error, codecStrategies, message }, 'Error processing feed message');
        nack(true);
      }
    }, { prefetch: 10 }
  );

  logger.info('Started consuming messages');
};

const waitForQueue = async (broker: Broker, queueName: string, maxRetries = 10): Promise<ReturnType<Broker['getQueue']> & {}> => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const queue = broker.getQueue(queueName);
    if (queue) return queue;

    const delayMs = Math.min(1000 * 2 ** attempt, 32000);
    logger.warn({ queue: queueName, attempt: attempt + 1, delayMs }, 'Queue not ready, retrying...');
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  throw new Error(`Queue '${queueName}' not available after ${maxRetries} retries`);
};
