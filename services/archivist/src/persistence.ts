import { Db, MongoError } from 'mongodb';
import amqp from 'amqplib';
import logger from './logger';
import { getCollectionName } from './mongodb';
import type { BitmexWSMessage } from './types';

const exchangeName = 'bitmex-data';
const queueName = 'bitmex-feed';

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
    await channel.assertExchange(exchangeName, 'topic', { durable: true });
    await channel.assertQueue(queueName, { durable: true });
    await channel.bindQueue(queueName, exchangeName, '#');

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

      if (data.data?.length) { // Ignore empty messages (should never happen, though)
        const minTimestamp = data.data.reduce(
            (min, d) => d.timestamp < min ? d.timestamp : min,
            data.data[0].timestamp
        );

        const hash = `${minTimestamp}_${data.action}_${data.data.length}`;

        await collection.insertOne({ ...data, _hash: hash } as any);

        onStoreMsg();
      }
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
