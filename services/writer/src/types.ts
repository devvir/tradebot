import type { Document } from 'mongodb';
import type { ConsumerEvent } from '@devvir/rabbitmq';

// ── Topology ─────────────────────────────────────────────────────────────────

/** Writer exchange and queue names — these are the writer's public API. */
export const EXCHANGE = 'writer';
export const DLX = 'writer.dlx';
export const DLQ = 'writer.dead-letter';

export const CONSUMER_QUEUES = {
  archive: 'writer.archive',
  collect: 'writer.collect',
  custom: 'writer.custom',
} as const;

export type ConsumerQueueName = (typeof CONSUMER_QUEUES)[keyof typeof CONSUMER_QUEUES];

// ── Config ───────────────────────────────────────────────────────────────────

export interface Config {
  mongodbUrl: string;
  rabbitmqUrl: string;
  prefetch: number;
  dbArchive: string;
  dbCollect: string;
  insertBatchSize: number;
  flushIntervalMs: number;
}

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * Resolved write target from a routing key.
 *
 * archive.orderBookL2    → { database: dbArchive, collection: 'orderBookL2' }
 * collect.trade          → { database: dbCollect, collection: 'trade' }
 * custom.mydb.mycol      → { database: 'mydb',   collection: 'mycol' }
 */
export interface WriteTarget {
  database: string;
  collection: string;
}

export interface BatchEntry {
  event: ConsumerEvent;
  document: Document;
}

export interface Batch {
  entries: BatchEntry[];
  database: string;
  collection: string;
}

// ── Error handling ───────────────────────────────────────────────────────────

export interface ErrorContext {
  collection: string;
  queue: string;
}
