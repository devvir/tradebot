import { MongoClient, Document } from 'mongodb';
import { logger } from '@devvir/service';
import type { ConsumerEvent } from '@devvir/rabbitmq';
import type { Config, WriteTarget, Batch, ErrorContext } from './types';
import { handleBatchError } from './errors';

// ── Constants ────────────────────────────────────────────────────────────────

const SLOW_INSERT_MS = 500;
const THROUGHPUT_LOG_INTERVAL = 5_000;

// ── Throughput tracking ──────────────────────────────────────────────────────

let totalInsertMs = 0;
let totalInserted = 0;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Flush a batch of documents to MongoDB via insertMany.
 * On failure, delegates to handleBatchError for partial/total failure recovery.
 */
export const persistBatch = async (
  mongo: MongoClient,
  batch: Batch,
  queueName: string,
  onStoreMsg: () => void,
): Promise<void> => {
  const db = mongo.db(batch.database);
  const collection = db.collection(batch.collection);
  const documents = batch.entries.map(e => e.document);
  const t0 = Date.now();

  try {
    await collection.insertMany(documents, { ordered: false });
    const insertMs = Date.now() - t0;
    totalInsertMs += insertMs;
    totalInserted += batch.entries.length;

    if (insertMs > SLOW_INSERT_MS) {
      logger.debug({ insertMs, collection: batch.collection, count: batch.entries.length, queue: queueName }, 'Slow insertMany');
    }

    if (totalInserted > 0 && totalInserted % THROUGHPUT_LOG_INTERVAL < batch.entries.length) {
      logger.debug({ inserted: totalInserted, queue: queueName, avgMs: (totalInsertMs / totalInserted).toFixed(2) }, 'Writer throughput');
    }

    for (const entry of batch.entries) {
      entry.event.ack();
      onStoreMsg();
    }
  } catch (error) {
    const insertMs = Date.now() - t0;
    const ctx: ErrorContext = { collection: batch.collection, queue: queueName };
    logger.error({ err: error, insertMs, collection: batch.collection, count: batch.entries.length, queue: queueName }, 'insertMany failed');
    await handleBatchError(error, batch.entries, collection, onStoreMsg, ctx);
  }
};

/**
 * Parse raw message content into a MongoDB document.
 * Revives JSON-serialized Buffers so MongoDB can store them as BSON Binary.
 */
export const parseDocument = (event: ConsumerEvent): Document => {
  return JSON.parse(event.original.content.toString(), bufferReviver) as Document;
};

/**
 * Resolve the target database and collection from an AMQP routing key.
 *
 * - archive.<collection>           → { database: config.dbArchive, collection }
 * - collect.<collection>           → { database: config.dbCollect, collection }
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

// ── Helpers ──────────────────────────────────────────────────────────────────

const bufferReviver = (_key: string, value: unknown): unknown => {
  if (value && typeof value === 'object' && (value as any).type === 'Buffer' && Array.isArray((value as any).data)) {
    return Buffer.from((value as any).data);
  }

  return value;
};
