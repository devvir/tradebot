import type { ConsumerEvent } from '@devvir/rabbitmq';
import { BitmexAction, BitmexTable } from '@tradebot/types';

// ── Config ───────────────────────────────────────────────────────────────────

export interface Config {
  mongodbUrl: string;
  rabbitmqUrl: string;
  prefetch: number;
  flushIntervalMs: number;
}

// ── Persistence ──────────────────────────────────────────────────────────────

export interface Manager {
  processing: number;
  process: () => void;
  enqueue: (message: unknown, delivery: ConsumerEvent) => void;
  flush: () => Promise<void>;
  flushAll: () => Promise<void>;
};

export interface Document {
  _id?: number;
  table: BitmexTable;
  action: BitmexAction;
  [key: string]: unknown;
}

export type StorableDocument = Omit<Document, 'table' | 'action'> & {
  _id: number;
}

export interface BatchEntry {
  ack: ConsumerEvent['ack'];
  nack: ConsumerEvent['nack'];
  metadata: ConsumerEvent['metadata'];
  document: StorableDocument;
  retries: number;
}

export interface BatchEntries extends Array<BatchEntry> {
  ack: ConsumerEvent['ack'];
  nack: ConsumerEvent['nack'];
}

export interface Batch {
  entries: BatchEntries;
  database: string;
  collection: string;
}
