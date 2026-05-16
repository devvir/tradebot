import type { MongoClient } from 'mongodb';
import { logger } from '@devvir/service-kit';
import { record } from './progress';
import type { PendingEntry } from './types';

const MAX_RETRIES   = 3;
const RETRY_DELAY_MS = 2_000;

export const flushBatch = async (
  mongo:      MongoClient,
  database:   string,
  collection: string,
  entries:    PendingEntry[],
): Promise<void> => {
  if (entries.length === 0) return;

  const documents = entries.map(e => ({ ...e.doc, _id: e._id }));

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await mongo.db(database).collection(collection).insertMany(
        documents as any[],
        { ordered: false },
      );

      ackStored(entries);
      logger.debug({ collection, count: entries.length }, 'Batch inserted');
      return;
    } catch (err: unknown) {
      const isMongoError = (e: unknown): e is { code?: number; writeErrors?: unknown[] } =>
        typeof e === 'object' && e !== null;

      // E11000 duplicate key — tolerate and ack (already persisted)
      if (isMongoError(err) && (err as any).code === 11000) {
        ackStored(entries);
        logger.debug({ collection, count: entries.length }, 'Duplicate key on insert — already persisted, acking');
        return;
      }

      logger.warn({ err, collection, attempt, max: MAX_RETRIES }, 'MongoDB insert error');

      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      } else {
        entries.forEach(e => e.nack(true));
        logger.error({ collection, count: entries.length }, 'Batch insert failed after max retries — nacking');
      }
    }
  }
};

/** Ack each entry and bump its bucket's progress counter — both halves of "safely stored". */
const ackStored = (entries: PendingEntry[]): void => {
  for (const e of entries) {
    e.ack();
    record(e.table, e.date, e.msgIndex);
  }
};
