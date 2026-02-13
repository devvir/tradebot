import { Db, Collection } from 'mongodb';
import amqp from 'amqplib';
import logger from './logger';
import { getCollectionName, extractMinimalAttributes } from './mongodb';
import { getIndexForCollection } from './indexes';

// Track which collections have had their indexes ensured
const checkedCollections = new Set<string>();

/**
 * Ensure unique indexes exist for a collection
 * Only checks once per collection per service lifetime
 */
const ensureIndexes = async (
  collection: Collection,
  collectionName: string
): Promise<void> => {
  // Skip if already checked
  if (checkedCollections.has(collectionName)) {
    return;
  }

  const indexDef = getIndexForCollection(collectionName);
  if (! indexDef) {
    logger.debug({ collectionName }, 'No index definition for collection');
    checkedCollections.add(collectionName);
    return;
  }

  try {
    // Check if index already exists
    const existingIndexes = await collection.indexes();
    const indexKeys = Object.keys(indexDef.spec);

    const indexExists = existingIndexes.some((idx) => {
      const keys = Object.keys(idx.key);
      return (
        keys.length === indexKeys.length &&
        keys.every((key) => indexKeys.includes(key))
      );
    });

    if (! indexExists) {
      await collection.createIndex(indexDef.spec, indexDef.options);
      logger.info(
        { collectionName, index: indexDef.spec },
        'Created unique index'
      );
    } else {
      logger.debug(
        { collectionName, index: indexDef.spec },
        'Index already exists'
      );
    }

    checkedCollections.add(collectionName);
  } catch (error) {
    logger.error(
      { error, collectionName },
      'Failed to ensure index, continuing without it'
    );
    // Mark as checked anyway to avoid repeated attempts
    checkedCollections.add(collectionName);
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
    const queueName = 'bitmex-data-archivist';

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
        await ensureIndexes(collection, collectionName);

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
          (error as { code?: string }).code === 'E11000'
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
