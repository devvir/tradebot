import amqp from 'amqplib';
import logger from './logger';

export interface RabbitMQConnection {
  connection: any;
  channel: amqp.Channel;
}

export const connectRabbitMQ = async (url: string): Promise<RabbitMQConnection> => {
  try {
    logger.info('Connecting to RabbitMQ...');
    const connection = await amqp.connect(url);
    const channel = await connection.createChannel();

    connection.on('error', (err: Error) => {
      logger.error({ err }, 'RabbitMQ connection error');
    });

    connection.on('close', () => {
      logger.warn('RabbitMQ connection closed');
    });

    logger.info('Connected to RabbitMQ');
    return { connection, channel };
  } catch (error) {
    logger.error({ error }, 'Failed to connect to RabbitMQ');
    throw error;
  }
};

export const publishToQueue = async (
  channel: amqp.Channel,
  data: Record<string, unknown>,
  ttlMs?: number
): Promise<void> => {
  if (!channel) {
    logger.warn('RabbitMQ channel not ready, skipping message');
    return;
  }

  try {
    const exchangeName = 'bitmex-data';
    const routingKey = `${data.table}`;

    await channel.assertExchange(exchangeName, 'topic', { durable: true });
    const messageBuffer = Buffer.from(JSON.stringify(data));

    const publishOptions: amqp.Options.Publish = { persistent: true };
    if (ttlMs) {
      publishOptions.expiration = ttlMs.toString();
    }

    // Use sendToQueue with callback to handle backpressure
    const canContinue = channel.publish(exchangeName, routingKey, messageBuffer, publishOptions);

    // If buffer is full, wait for drain event
    if (!canContinue) {
      await new Promise<void>((resolve) => {
        channel.once('drain', () => resolve());
      });
    }
  } catch (error) {
    logger.error({ error, data }, 'Failed to publish to RabbitMQ');
  }
};
