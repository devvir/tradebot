import { MongoClient, Db, MongoError, Long, Binary } from 'mongodb';
import amqp from 'amqplib';
import logger from '@tradebot/logger';

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

const queueName = 'archivist';

export const startConsuming = async (
  channel: amqp.Channel,
  db: Db,
  batchSize: number,
  onStoreMsg: () => void
): Promise<void> => {
  try {
    await channel.assertQueue(queueName, { durable: true });

    logger.info({ queue: queueName }, 'Consuming from queue');
    await channel.prefetch(batchSize);

    consume(channel, db, onStoreMsg);
  } catch (e) {
    logger.error({ e }, 'Failed to start consuming');
    throw e;
  }
};

const consume = async (channel: amqp.Channel, db: Db, onStoreMsg: () => void): Promise<void> => {
  channel.consume(queueName, async (msg) => {
    if (! msg) return;

    try {
      const document = createDocument(msg);
      const collection = db.collection(getCollectionName(msg));

      await collection.insertOne(document);
      onStoreMsg();
    } catch (e) {
      if (! (e instanceof MongoError) || e.code !== 11000) {
        logger.error({ e }, 'Error processing message');
        channel.nack(msg, false, true);
        return;
      }
    }

    channel.ack(msg);
  });
};

/**
 * Extract collection name from RabbitMQ message headers.
 */
const getCollectionName = (msg: amqp.ConsumeMessage): string => {
  const table = msg.properties?.headers?.table as string | undefined;

  if (! table) {
    throw new Error('Message missing required table header');
  }

  return table;
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
