import type { Document } from 'mongodb';
import type { ConsumerEvent } from '@devvir/rabbitmq';

// ── Config ───────────────────────────────────────────────────────────────────

export interface Config {
  mongodbUrl: string;
  rabbitmqUrl: string;
  prefetch: number;
  flushIntervalMs: number;
}

// ── Persistence ──────────────────────────────────────────────────────────────

export interface BatchEntry {
  delivery: ConsumerEvent;
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
