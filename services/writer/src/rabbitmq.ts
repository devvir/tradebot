import { keepAlive, Broker } from '@devvir/rabbitmq';

/** Writer exchange and queue names */
export const EXCHANGE = 'writer';
export const QUEUE = 'writer';
export const DLX = 'writer.dlx';
export const DLQ = 'writer.dead-letter';

/**
 * Creates and configures a RabbitMQ broker.
 */
export const connectToQueue = async (connectionUrl: string): Promise<Broker> => {
  const broker = await keepAlive(connectionUrl);

  return broker.declares({
    exchanges: {
      [EXCHANGE]: {
        type: 'topic',
        queues: {
          [QUEUE]: { routingKey: '#', deadLetterExchange: DLX },
        },
      },

      /** Dead-letter exchange */
      [DLX]: { type: 'fanout', queues: { [DLQ]: {} } },
    },
  });
};
