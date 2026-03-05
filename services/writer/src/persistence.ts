import { MongoClient, Document } from 'mongodb';
import { logger } from '@devvir/service';
import type { ConsumerEvent } from '@devvir/rabbitmq';
import type { Config, Batch, ErrorContext } from './types';
import { handleBatchError } from './errors';
import { generateId, EPOCH_2000_MS, ACTION_ID, type BitmexAction } from './documentId';

const THROUGHPUT_LOG_INTERVAL = 5_000;

let totalInsertMs = 0;
let totalInserted = 0;

/**
 * Creates a stateful batch ingestor for a single queue.
 * Accumulates documents into per-collection batches and flushes via persistBatch.
 * Throws on invalid message headers or body — caller should nack.
 */
export interface BatchHandler {
  handleMessage: (delivery: ConsumerEvent, database: string) => void;
  drainAll: () => Promise<void>;
}

export const createBatchHandler = (
  mongo: MongoClient,
  config: Config,
  queueName: string,
  onStoreMsg: () => void,
): BatchHandler => {
  const { flushIntervalMs } = config;
  const pending = new Map<string, Batch>();
  let flushTimer: NodeJS.Timeout | null = null;
  const inFlight = new Set<Promise<void>>();

  const flush = (key: string): void => {
    const batch = pending.get(key);
    if (! batch || batch.entries.length === 0) return;

    const snapshot: Batch = {
      database: batch.database,
      collection: batch.collection,
      entries: batch.entries.splice(0),
    };

    pending.delete(key);

    const promise = persistBatch(mongo, snapshot, queueName, onStoreMsg)
      .catch(err => logger.error({ err, queueName }, 'Unexpected persistBatch error'));
    inFlight.add(promise);
    promise.finally(() => inFlight.delete(promise));
  };

  const scheduleFlush = (): void => {
    if (flushTimer) return;

    flushTimer = setTimeout(() => {
      flushTimer = null;
      for (const key of Array.from(pending.keys())) flush(key);
    }, flushIntervalMs);
  };

  const drainAll = async (): Promise<void> => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    for (const key of Array.from(pending.keys())) flush(key);
    await Promise.all(Array.from(inFlight));
  };

  const handleMessage = (delivery: ConsumerEvent, database: string): void => {
    const { document, collection } = parseDocument(delivery);
    const key = `${database}|${collection}`;

    if (! pending.has(key))
      pending.set(key, { entries: [], database, collection });

    const batch = pending.get(key)!;
    batch.entries.push({ delivery, document });
    scheduleFlush();
  };

  return { handleMessage, drainAll };
};

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

    if (totalInserted > 0 && totalInserted % THROUGHPUT_LOG_INTERVAL < batch.entries.length) {
      const averageMs = (totalInsertMs / totalInserted).toFixed(2);
      logger.debug({ totalInserted, queueName, averageMs }, 'Writer throughput');
    }

    for (const entry of batch.entries) {
      entry.delivery.ack();
      onStoreMsg();
    }
  } catch (err) {
    const errMsg = (err as Error).message ?? err;
    const ctx: ErrorContext = { collection: batch.collection, queue: queueName };
    logger.error({ err: errMsg, count: batch.entries.length, queueName }, 'Batch insert failed');

    await handleBatchError(err, batch.entries, collection, onStoreMsg, ctx);
  }
};

/**
 * Parse raw message content into a MongoDB document.
 *
 * - Reads doc.table (required) to determine the target collection.
 * - If doc._id is already present, it is used as-is (e.g. document originated from DB).
 * - Otherwise, builds _id from doc.action (required) and the x-bitmex-published-at header
 *   (falls back to current time if absent).
 * - Deletes doc.table and doc.action before returning — both are redundant in storage
 *   (table = collection name, action = last 2 bits of _id).
 *
 * Throws (causing the caller to nack) if any required field is missing or invalid.
 */
export const parseDocument = (delivery: ConsumerEvent): { document: Document; collection: string } => {
  const doc = JSON.parse(delivery.original.content.toString(), bufferReviver) as Document;

  const table = doc.table;
  if (typeof table !== 'string' || table === '')
    throw new Error(`Missing or invalid doc.table: ${table}`);

  if (doc._id === undefined) {
    const action = doc.action;
    if (typeof action !== 'string' || ! (action in ACTION_ID))
      throw new Error(`Missing or invalid doc.action: ${action}`);

    const headers  = delivery.metadata.headers ?? {};
    const rawTs    = headers['x-bitmex-published-at'];
    const tsMs     = (typeof rawTs === 'string' ? new Date(rawTs).getTime() : Date.now()) - EPOCH_2000_MS;

    doc._id = generateId(table, action as BitmexAction, tsMs);
  }

  delete doc.table;
  delete doc.action;

  return { document: doc, collection: table };
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const bufferReviver = (_key: string, value: unknown): unknown => {
  if (
    value &&
    typeof value === 'object' &&
    (value as any).type === 'Buffer' &&
    Array.isArray((value as any).data)
  ) {
    return Buffer.from((value as any).data);
  }

  return value;
};
