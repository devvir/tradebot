// Pending Review
import { logger } from '@devvir/service';
import { keepAlive, Broker } from '@devvir/rabbitmq';
import { codecStrategies } from './config';
import type { Config } from './types';
import { transform } from './encoding';

/**
 * Creates and configures a RabbitMQ broker.
 * Sets up the necessary message topology for this service.
 *
 * Connection lifecycle events are logged by the broker.
 */
export const connectToQueue = async (config: Config): Promise<Broker> => {
  logger.info('Setting up RabbitMQ broker...');
  const broker = await keepAlive(config.rabbitmqUrl);
  logger.info('Successfully connected to RabbitMQ');

  broker.declares({
    exchanges: {
      [config.inboundExchange]: {
        type: 'topic',
        queues: { [config.inboundQueue]: { routingKey: '#' } },
      },
      [config.outboundExchange]: {
        type: 'topic',
        queues: { [config.outboundQueue]: { routingKey: '#' } },
      },
    }
  });

  return broker;
};

export const startConsuming = async (broker: Broker, config: Config, onProcessMsg: () => void): Promise<void> => {
  const inputQueue = await waitForQueue(broker, config.inboundQueue);
  const outputExchange = broker.getExchange(config.outboundExchange)!;

  logger.info({ queue: config.inboundQueue, prefetch: config.prefetch }, 'Starting message consumption');

  await inputQueue.consume(
    async (message, { ack, nack, original: rawMsg }) => {
      if (! message) return;

      try {
        onProcessMsg();

        const result = transform(rawMsg, message);
        if (! result) {
          logger.error({ routingKey: rawMsg.fields.routingKey }, 'Transform failed, nacking message');
          nack(true);
          return;
        }

        await outputExchange.publishAsync(result.payload, rawMsg.fields.routingKey, {
          headers: result.headers,
          contentType: result.contentType,
        });

        ack();
      } catch (e) {
        const msgPreview = typeof message === 'string'
          ? message.slice(0, 200)
          : Buffer.isBuffer(message) ? '[Binary]' : JSON.stringify(message).slice(0, 200);

        logger.error({ err: e, message: msgPreview, codecStrategies }, 'Error processing message');
        nack(true);
      }
    }, { prefetch: config.prefetch }
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
