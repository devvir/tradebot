import amqp from 'amqplib';
import { MongoClient, MongoError } from 'mongodb';
import { logger } from '@devvir/service';
import { Config, MongoDBConnection, CONSUMER_QUEUES, WriteTarget } from './types';

/**
 * Connect to MongoDB with exponential backoff retry logic.
 * Ensures service startup waits for database availability.
 */
export const connectToDatabase = async (
  mongodbUrl: string,
  maxRetries = 10,
  delayMs = 5000
): Promise<MongoDBConnection> => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const connection = await connect(mongodbUrl);
      logger.info('Successfully connected to MongoDB');

      return connection;
    } catch (error) {
      logger.warn({ error, attempt: i + 1, maxRetries }, 'Failed to connect to MongoDB, retrying...');

      if (i < maxRetries - 1) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(`Failed to connect to MongoDB after ${maxRetries} attempts`);
};

/**
 * Start consuming from all writer queues (archive, collect, custom).
 * Each queue resolves database + collection from the routing key.
 */
export const startConsuming = async (
  channel: amqp.Channel,
  client: MongoClient,
  config: Config,
  onStoreMsg: () => void
): Promise<void> => {
  await channel.prefetch(config.batchSize);

  for (const queueName of Object.values(CONSUMER_QUEUES)) {
    logger.info({ queue: queueName }, 'Consuming from queue');

    consume(channel, client, config, queueName, onStoreMsg);
  }
};

const connect = async (url: string): Promise<MongoDBConnection> => {
  logger.info('Connecting to MongoDB...');

  try {
    const client = new MongoClient(url);

    await client.connect();

    logger.info('Connected to MongoDB');

    return { client };
  } catch (error) {
    logger.error({ error }, 'Failed to connect to MongoDB');
    throw error;
  }
};

const consume = (channel: amqp.Channel, client: MongoClient, config: Config, queueName: string, onStoreMsg: () => void): void => {
  channel.consume(queueName, async (msg: amqp.ConsumeMessage | null) => {
    if (! msg) return;

    try {
      const routingKey = msg.fields.routingKey;
      const target = resolveTarget(routingKey, config);

      if (! target) {
        logger.error({ routingKey }, 'Cannot resolve write target from routing key');
        return channel.nack(msg, false, false);
      }

      const db = client.db(target.database);
      const collection = db.collection(target.collection);

      const document = JSON.parse(msg.content.toString(), bufferReviver);
      await collection.insertOne(document);
    } catch (e) {
      if (e instanceof MongoError && e.code === 11000) {
        onStoreMsg();
        return channel.ack(msg);
      }

      const requeue = e instanceof MongoError;

      logger.error({ err: e, routingKey: msg.fields.routingKey, requeue }, 'Error processing message');

      return channel.nack(msg, false, requeue);
    }

    onStoreMsg();
    channel.ack(msg);
  });
};

/**
 * Resolve the target database and collection from an AMQP routing key.
 *
 * - archive.<collection>         → { database: config.dbArchive, collection }
 * - collect.<collection>         → { database: config.dbCollect, collection }
 * - custom.<database>.<collection> → { database, collection }
 */
export const resolveTarget = (routingKey: string, config: Config): WriteTarget | null => {
  const parts = routingKey.split('.');

  if (parts.length < 2) return null;

  const prefix = parts[0];

  if (prefix === 'archive') return { database: config.dbArchive, collection: parts[1] };
  if (prefix === 'collect') return { database: config.dbCollect, collection: parts[1] };
  if (prefix === 'custom' && parts.length >= 3) return { database: parts[1], collection: parts[2] };

  return null;
};

/**
 * Revive JSON-serialized Buffers back into Buffer (so MongoDB can store them as BSON Binary).
 * */
const bufferReviver = (_key: string, value: unknown): unknown => {
  if (value && typeof value === 'object' && (value as any).type === 'Buffer' && Array.isArray((value as any).data)) {
    return Buffer.from((value as any).data);
  }

  return value;
};
