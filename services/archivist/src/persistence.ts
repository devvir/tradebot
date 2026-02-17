import { Db, MongoError } from 'mongodb';
import amqp from 'amqplib';
import logger from './logger';
import { getCollectionName } from './mongodb';
import type { BitmexWSMessage } from './types';

const queueName = 'archivist';

// Track which collections have had their indexes ensured
const indexedCollections = new Set<string>();

/**
 * Ensure unique index exists for every collection
 * Only checks once per collection per service lifetime
 */
const ensureIndexedCollection = async (db: Db, collectionName: string): Promise<void> => {
  try {
    const collection = await db.listCollections({ name: collectionName }).hasNext()
        ? await db.collection(collectionName)
        : await db.createCollection(collectionName);

    await collection.createIndex({ _hash: 1 }, { unique: true });

    logger.info(`Ensured unique index for collection: ${collectionName}`);
  } catch (e) {
    if (! (e instanceof MongoError) || e.code !== 11000) {
      indexedCollections.delete(collectionName);
      logger.error({ error: e, collectionName }, 'Failed to ensure index, will retry');
    }
  }
};

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
  channel.consume(queueName, async (msg: any) => {
    if (! msg) return;

    try {
      const data = JSON.parse(msg.content.toString()) as BitmexWSMessage;
      const collectionName = getCollectionName(data);
      const collection = db.collection(collectionName);

      // Ensure indexes exist for this collection
      if (! indexedCollections.has(collectionName)) {
          indexedCollections.add(collectionName);
          await ensureIndexedCollection(db, collectionName);
      }

      const minTimestamp = data.data.reduce(
          (min, d) => d.timestamp < min ? d.timestamp : min,
          data.data[0]?.timestamp
      ) ?? new Date().toISOString();

      const hash = `${minTimestamp}_${data.action}_${data.data.length}`;

      await collection.insertOne({ ...data, _hash: hash } as any);

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
}
