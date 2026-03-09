import { logger } from '@devvir/service';
import { keepAlive, Broker } from '@devvir/rabbitmq';
import type { Config, Message } from './types';
import { transform } from './encoding';

export const INBOUND_QUEUE = 'codec';
export const INBOUND_EXCHANGE = 'codec.in';
export const OUTBOUND_EXCHANGE = 'codec.out';

/**
 * Creates and configures a RabbitMQ broker.
 *
 * Connection lifecycle events are logged by the broker.
 */
export const connectToQueue = async (config: Config): Promise<Broker> => {
  const broker = await keepAlive(config.rabbitmqUrl);

  return await broker.declares({
    exchanges: {
      [OUTBOUND_EXCHANGE]: { type: 'topic' },

      [INBOUND_EXCHANGE]: {
        type: 'topic',
        queues: { [INBOUND_QUEUE]: { routingKey: '#' } },
      },
    },
  });
};

export const startConsuming = async (broker: Broker, config: Config, onProcessMsg: () => void): Promise<void> => {
  const inboundQueue = broker.getQueue(INBOUND_QUEUE)!;
  const outputExchange = broker.getExchange(OUTBOUND_EXCHANGE)!;

  logger.info({ queue: INBOUND_QUEUE, prefetch: config.prefetch }, 'Started message consumption');

  await inboundQueue.consume(async (message, { ack, nack, original }) => {
    if (! message) return;

    try {
      onProcessMsg();

      const content = transform(original, message as Message);

      await outputExchange.republish({ ...original, content });

      ack();
    } catch (err) {
      const msgPreview = typeof message === 'string'
        ? message.slice(0, 200)
        : Buffer.isBuffer(message) ? '[Binary]' : JSON.stringify(message).slice(0, 200);

      logger.error({ err, message: msgPreview }, 'Error processing message');
      nack(true);
    }
  }, { prefetch: config.prefetch });
};
