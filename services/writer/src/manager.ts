import { Document as MongoDocument, MongoClient, MongoBulkWriteError, WriteError, Collection } from "mongodb";
import { logger } from '@devvir/service-kit';
import { BatchEntries, Config, ConsumerEvent, Document, Manager } from "./types";
import { addToBatch, flushStore } from "./batch";
import generateId from "./documentId";
import { pause, paused } from "./semaphore";
import { handleDuplicates, sampleTimestamp } from "./duplicates";

export default (config: Config, mongo: MongoClient): Manager => ({
  processing: 0,

  /**
   * Start processing and storing document batches
   */
  process() {
    logger.info('Writer started processing documents');
    setInterval(() => paused() || this.flush(), config.flushIntervalMs);
  },

  /**
   * Enqueue a single message in the corresponding batch.
   *
   * Batches handle their own flush schedule and will ack/nack messages as appropriate.
   */
  enqueue(message, { ack, nack, metadata }) {
    if (! message || typeof message !== 'object' || ! ('table' in message) || ! ('action' in message)) {
      logger.warn({ message }, 'Received invalid message, skipping');
      return ack();
    }

    const database = metadata.headers?.['x-writer-database'] ?? 'tradebot';
    const document = message as Document;
    const timestamp = metadata.headers?.['x-bitmex-published-at'];

    document._id = getDocumentId(document, timestamp);

    sampleTimestamp(Math.floor(document._id / 4096));

    addToBatch(database, document, { ack, nack, metadata } as ConsumerEvent);
  },

  /**
   * Flush pending batches.
   */
  async flush() {
    this.processing++;

    const batches = flushStore();

    await Promise.all(batches.map(async ({ database, collection, entries }) => {
      const db = mongo.db(database).collection(collection);

      try {
        await db.insertMany(entries.map(e => e.document as MongoDocument), { ordered: false });
        entries.ack();
      } catch (err) {
        /** BulkWrite errors require special care: partial ack, duplicate key handling, etc. */
        if (err instanceof MongoBulkWriteError) {
          return handleBatchInsertFailure(db, entries, err);
        }

        /** Other errors are likely transient and should be retried after a brief pause */
        pause(1000);

        logger.error({ err, database, collection }, 'Unexpected Mongo error. Requeueing...');

        return entries.nack(true);
      }
    }));

    this.processing--;
  },

  /**
   * Flush pending batches, and wait for any in-flight batches to complete.
   */
  flushAll() {
    return new Promise<void>(async resolve => {
      await this.flush();

      const check = () => {
        if (this.processing === 0) return resolve();
        setTimeout(check, 100);
      };

      check();
    });
  }
});

/**
 * Get a unique ID for this document.
 *
 * If the document already has an id, use it. Otherwise, generate a unique ID for it.
 */
const getDocumentId = (document: Document, publishedAt?: number): number => {
  if (typeof document._id === 'number') return document._id;

  const tsMs = publishedAt ? new Date(publishedAt).getTime() : Date.now();

  return generateId(document, tsMs);
}

/**
 * Handle MongoBulkWriteError thrown when attempting to persist a batch of documents.
 *
 * { "index": 0, "code": 11000, "errmsg": "E11000 duplicate key error ..." }
 */
const handleBatchInsertFailure = (
  db: Collection<MongoDocument>,
  entries: BatchEntries,
  { writeErrors }: MongoBulkWriteError,
) => {
  const nacked = new Map<number, number>();

  for (const error of writeErrors as WriteError[]) {
    nacked.set(error.index, error.code);
  }

  // Ack successful writes
  entries.filter((_, i) => ! nacked.has(i)).forEach(e => e.ack());

  // Nack and report non-duplicate failures
  entries.filter((_, i) => nacked.has(i) && nacked.get(i) !== 11000).forEach((e, i) => {
    e.nack(! e.metadata.redelivered);
    const { data, b, ...document } = e.document;
    logger.warn({ err: `Cannot persist document (one retry)`, code: nacked.get(i), document });
  });

  // Finally, handle duplicates
  handleDuplicates(db, entries.filter((_, i) => nacked.get(i) === 11000));
};