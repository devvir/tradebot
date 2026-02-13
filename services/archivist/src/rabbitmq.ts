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
