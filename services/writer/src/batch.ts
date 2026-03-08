import { BitmexTable } from '@tradebot/types';
import { Batch, BatchEntries, BatchEntry, Document, StorableDocument } from './types';
import { mapGet } from '@tradebot/utils';
import { ConsumerEvent } from '@devvir/rabbitmq';

const STORE =new Map<string, Batch>();

/**
 * Add a document to its corresponding batch, creating the batch if it doesn't exist.
 */
export const addToBatch = (
  database: string,
  document: Document,
  { ack, nack, metadata }: ConsumerEvent,
  retries: number = 0,
): void => {
  const collection = document.table;
  const batchKey = `${database}:${collection}`;
  const { table, action, ...storable } = document as StorableDocument;

  const batch = mapGet<Batch>(STORE, batchKey, () => ({
    database,
    collection,
    entries: entries(),
  }))!;

  batch.entries.push({ document: storable, ack, nack, metadata, retries });
};

/**
 * Return the specified batch and remove it from the store.
 */
export const flushBatch = (database: string, collection: BitmexTable): Batch | undefined => {
  const batchKey = `${database}:${collection}`;

  const batch = mapGet<Batch | undefined>(STORE, batchKey);

  STORE.delete(batchKey);

  return batch;
};

/**
 * Return all existing batches and clear the store.
 */
export const flushStore = (): Batch[] => {
  const batches = Array.from(STORE.values());

  STORE.clear();

  return batches;
};

/**
 * Augmented array of entries, exposing batch ack/nack.
 *
 * NOTE: entries.nack() requeues only once, unless requeue is explicitly passed.
 */
const entries = (): BatchEntries => {
  const entries: BatchEntry[] = [];

  (entries as BatchEntries).ack = () => entries.forEach(e => e.ack());
  (entries as BatchEntries).nack = (requeue?: boolean) => {
    entries.forEach(e => e.nack(requeue ?? e.metadata.redelivered));
  };

  return entries as BatchEntries;
};