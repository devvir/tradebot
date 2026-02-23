import amqp from 'amqplib';
import { MongoClient, Db, MongoError, Long, Binary } from 'mongodb';
import { logger } from '@devvir/service';
import { Config } from './types';

export interface MongoDBConnection {
  client: MongoClient;
  db: Db;
}

export const connectToDatabase = async (url: string): Promise<MongoDBConnection> => {
  logger.info('Connecting to MongoDB...');

  try {
    const client = new MongoClient(url);
    const db = client.db();

    await client.connect();

    logger.info('Connected to MongoDB');

    return { client, db };
  } catch (error) {
    logger.error({ error }, 'Failed to connect to MongoDB');
    throw error;
  }
};

/**
 * Connect to MongoDB with exponential backoff retry logic.
 * Ensures service startup waits for database availability.
 */
export const connectMongoWithRetry = async (
  mongodbUrl: string,
  maxRetries = 10,
  delayMs = 5000
): Promise<MongoDBConnection> => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const connection = await connectToDatabase(mongodbUrl);
      logger.info('Successfully connected to MongoDB');

      return connection;
    } catch (error) {
      logger.warn({ error, attempt: i + 1, maxRetries }, 'Failed to connect to MongoDB, retrying...');

      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  throw new Error(`Failed to connect to MongoDB after ${maxRetries} attempts`);
};

export const startConsuming = async (
  channel: amqp.Channel,
  db: Db,
  { batchSize, queueName }: Config,
  onStoreMsg: () => void
): Promise<void> => {
  try {
    await channel.assertQueue(queueName);

    logger.info({ queue: queueName }, 'Consuming from queue');
    await channel.prefetch(batchSize);

    consume(channel, db, queueName, onStoreMsg);
  } catch (e) {
    logger.error({ err: e }, 'Failed to start consuming');
    throw e;
  }
};

const consume = (channel: amqp.Channel, db: Db, queueName: string, onStoreMsg: () => void): void => {
  channel.consume(queueName, async (msg: amqp.ConsumeMessage | null) => {
    if (! msg) return;

    try {
      const collectionName = msg.fields.routingKey;

      const document = createDocument(msg);
      const collection = db.collection(collectionName);

      await collection.insertOne(document);
      onStoreMsg();
    } catch (e) {
      if (! (e instanceof MongoError) || e.code !== 11000) {
        logger.error({ err: e }, 'Error processing message');
        channel.nack(msg, false, true);
        return;
      }
    }

    channel.ack(msg);
  });
};

/**
 * Create MongoDB document from RabbitMQ message (content + headers).
 */
const createDocument = (msg: amqp.ConsumeMessage): Record<string, unknown> => {
  const rawMetadata: Record<string, unknown> = msg.properties?.headers?.metadata || {};
  const contentType = msg.properties?.contentType || 'application/json';

  // Deserialise metadata: Buffer values are treated as big-endian int64 → BSON Long
  const metadata = Object.fromEntries(
    Object.entries(rawMetadata).map(([k, v]) =>
      [ k, Buffer.isBuffer(v) ? Long.fromBigInt(v.readBigUInt64BE()) : v ])
  );

  const data = (contentType === 'application/octet-stream')
    ? { b: new Binary(msg.content) }
    : JSON.parse(msg.content.toString());

  return { ...metadata, ...data };
};
