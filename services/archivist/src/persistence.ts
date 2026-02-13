import { Db, MongoError } from 'mongodb';
import amqp from 'amqplib';
import logger from './logger';
import { getCollectionName, extractMinimalAttributes } from './mongodb';
import { getIndexForCollection } from './indexes';

// Track which collections have had their indexes ensured
const indexedCollections = new Set<string>();

/**
 * Ensure unique indexes exist for a collection
 * Only checks once per collection per service lifetime
 */
const ensureIndexedCollection = async (db: Db, collectionName: string): Promise<void> => {
  let collection;
  const { spec, options } = getIndexForCollection(collectionName)!;

  try {
    collection = await db.listCollections({ name: collectionName }).hasNext()
        ? await db.collection(collectionName)
        : await db.createCollection(collectionName);

    await collection.createIndex(spec, options);

    logger.info({ collectionName, spec }, 'Ensured unique index');
  } catch (error) {
    if (! (error instanceof MongoError) || error.code !== 11000) {
      indexedCollections.delete(collectionName);
      logger.error({ error, collectionName }, 'Failed to ensure index, will retry');
    }
  }
};

export const startConsuming = async (
  channel: amqp.Channel,
  db: Db,
  batchSize: number,
  onMessageProcessed: () => void
): Promise<void> => {
  try {
    const exchangeName = 'bitmex-data';
    const queueName = 'bitmex-feed';

    await channel.assertExchange(exchangeName, 'topic', { durable: true });
    await channel.assertQueue(queueName, { durable: true });
    await channel.bindQueue(queueName, exchangeName, '#');

    logger.info({ queue: queueName }, 'Consuming from queue');
    await channel.prefetch(batchSize);

    channel.consume(queueName, async (msg: any) => {
      if (!msg) return;

      try {
        const data = JSON.parse(msg.content.toString()) as Record<string, unknown>;
        const collectionName = getCollectionName(data);
        const collection = db.collection(collectionName);

        // Ensure indexes exist for this collection
        if (! indexedCollections.has(collectionName)) {
            indexedCollections.add(collectionName);
            await ensureIndexedCollection(db, collectionName);
        }

        // Extract API version from message metadata
        const apiVersion = (data._apiVersion as string) || null;
        const action = data.action as string;
        const timestamp = data.timestamp as string | number;

        const dataArray = (data.data as Array<Record<string, unknown>>) || [];
        const documentsToInsert = dataArray.map((doc) => {
          const enriched = extractMinimalAttributes(doc, apiVersion);
          // Preserve action and message timestamp for replay capability
          enriched._action = action;
          enriched._messageTimestamp = timestamp;
          return enriched;
        });

        if (documentsToInsert.length > 0) {
          await collection.insertMany(documentsToInsert, { ordered: false });
        }

        onMessageProcessed();
        channel.ack(msg);
      } catch (error) {
        if (
          error instanceof Error &&
          (error as { code?: number }).code === 11000
        ) {
          logger.debug({ error }, 'Duplicate document, skipping');
          channel.ack(msg);
        } else {
          logger.error({ error }, 'Error processing message');
          channel.nack(msg, false, true);
        }
      }
    });
  } catch (error) {
    logger.error({ error }, 'Failed to start consuming');
    throw error;
  }
};
