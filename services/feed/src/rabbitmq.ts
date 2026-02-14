import amqp from 'amqplib';
import logger from './logger';

export interface RabbitMQConnection {
  connection: amqp.Connection & { close(): Promise<void> };
  channel: amqp.Channel;
}

let reconnectTimeout: NodeJS.Timeout | null = null;
let reconnectUrl: string | null = null;
let onReconnectCallback: ((conn: RabbitMQConnection) => void) | null = null;
let onChannelInvalidatedCallback: (() => void) | null = null;

// Track pending drain waiters to avoid listener leaks
const drainWaiters = new Set<() => void>();

const setupDisconnectHandlers = (conn: RabbitMQConnection): void => {
  const clearChannel = () => {
    if (onChannelInvalidatedCallback) {
      logger.warn('Clearing channel reference due to disconnection');
      onChannelInvalidatedCallback();
    }
  };

  conn.connection.once('error', clearChannel);
  conn.connection.once('close', clearChannel);
  conn.channel.once('error', clearChannel);
  conn.channel.once('close', clearChannel);
};

export const connectRabbitMQ = async (
  url: string,
  onReconnect?: (conn: RabbitMQConnection) => void,
  onChannelInvalidated?: () => void
): Promise<RabbitMQConnection> => {
  logger.info('Connecting to RabbitMQ...');

  reconnectUrl = url;
  if (onReconnect) {
    onReconnectCallback = onReconnect;
  }
  if (onChannelInvalidated) {
    onChannelInvalidatedCallback = onChannelInvalidated;
  }

  try {
    const connection = await amqp.connect(url);
    const channel = await connection.createChannel();

    channel.setMaxListeners(50);

    channel.on('drain', () => {
      logger.debug({ waiters: drainWaiters.size }, 'Channel drained, resolving waiters');
      drainWaiters.forEach(resolve => resolve());
      drainWaiters.clear();
    });

    connection.on('error', (err: Error) => {
      logger.error({ err }, 'RabbitMQ connection error');
      scheduleReconnect();
    });

    connection.on('close', () => {
      logger.warn('RabbitMQ connection closed');
      scheduleReconnect();
    });

    channel.on('error', (err: Error) => {
      logger.error({ err }, 'RabbitMQ channel error');
    });

    channel.on('close', () => {
      logger.warn('RabbitMQ channel closed');
      drainWaiters.forEach((resolve) => resolve());
      drainWaiters.clear();
    });

    const exchangeName = 'bitmex-data';
    const queueName = 'bitmex-feed';
    await channel.assertExchange(exchangeName, 'topic', { durable: true });
    await channel.assertQueue(queueName, { durable: true });
    await channel.bindQueue(queueName, exchangeName, '#');

    const conn = {
      connection: connection as unknown as RabbitMQConnection['connection'],
      channel,
    };

    setupDisconnectHandlers(conn);

    return conn;
  } catch (error) {
    logger.error({ error }, 'Failed to connect to RabbitMQ');
    scheduleReconnect();
    throw error;
  }
};

const scheduleReconnect = (): void => {
  if (reconnectTimeout || ! reconnectUrl || ! onReconnectCallback) {
    return;
  }

  reconnectTimeout = setTimeout(async () => {
    reconnectTimeout = null;
    logger.info('Attempting to reconnect to RabbitMQ...');
    try {
      const newConnection = await connectRabbitMQ(reconnectUrl!, onReconnectCallback!, onChannelInvalidatedCallback!);
      onReconnectCallback!(newConnection);
    } catch (error) {
      logger.error({ error }, 'RabbitMQ reconnection failed, will retry');
    }
  }, 5000);
};

export const connectWithRetry = async (
  url: string,
  onReconnect: (conn: RabbitMQConnection) => void,
  onChannelInvalidated: () => void,
  maxRetries = 10,
  delayMs = 3000
): Promise<RabbitMQConnection> => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const connection = await connectRabbitMQ(url, onReconnect, onChannelInvalidated);
      logger.info('Successfully connected to RabbitMQ');
      return connection;
    } catch (error) {
      logger.warn({ error, attempt: i + 1, maxRetries }, 'Failed to connect to RabbitMQ, retrying...');
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw new Error(`Failed to connect to RabbitMQ after ${maxRetries} attempts`);
};

export const publishToQueue = async (
  channel: amqp.Channel | null,
  data: Record<string, unknown>,
  ttlMs?: number
): Promise<void> => {
  if (! channel) {
    logger.debug('RabbitMQ channel not ready, skipping message');
    return;
  }

  // Check if channel is actually writable
  try {
    // @ts-expect-error - accessing internal property to check state
    if (channel.connection?.connection?.stream?.destroyed) {
      logger.debug('RabbitMQ connection destroyed, skipping message');
      return;
    }
  } catch {
    // If we can't check state, try to publish anyway
  }

  try {
    const exchangeName = 'bitmex-data';
    const routingKey = data.symbol ? `${data.table}.${data.symbol}` : `${data.table}`;
    const messageBuffer = Buffer.from(JSON.stringify(data));

    const publishOptions: amqp.Options.Publish = { persistent: true };
    if (ttlMs) {
      publishOptions.expiration = ttlMs.toString();
    }

    // Publish to exchange; queue was asserted during connection
    const canContinue = channel.publish(exchangeName, routingKey, messageBuffer, publishOptions);

    // If buffer is full, wait for drain event using shared handler
    if (! canContinue) {
      await new Promise<void>((resolve) => {
        drainWaiters.add(resolve);

        // Safety timeout to prevent indefinite waiting
        setTimeout(() => {
          if (drainWaiters.has(resolve)) {
            drainWaiters.delete(resolve);
            resolve();
          }
        }, 5000);
      });
    }
  } catch (error) {
    logger.error({ error, data }, 'Failed to publish to RabbitMQ');
  }
};
