import { logger } from '@devvir/service-kit';
import type { MongoClient } from 'mongodb';
import type { Config } from '../types';

/**
 * Tables that store individual data records (one doc = one event).
 * The REST API queries these by `timestamp` range, optionally narrowed by `symbol`.
 * A compound `{ symbol: 1, timestamp: 1 }` index serves both shapes.
 *
 * WS-origin tables (instrument, orderBookL2, …) page by `_id` only, which is
 * indexed by default — no extra index needed.
 *
 * `insurance` is keyed by `currency` rather than `symbol`; indexed separately.
 */
const SYMBOL_TIMESTAMP_TABLES = [
  'trade', 'quote',
  'funding', 'settlement',
  'tradeBin1m', 'tradeBin5m', 'tradeBin1h', 'tradeBin1d',
  'quoteBin1m', 'quoteBin5m', 'quoteBin1h', 'quoteBin1d',
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Ensure REST API queries are index-backed. Idempotent — `createIndex` is a
 * no-op when the index already exists.
 */
export const ensureIndexes = async (mongo: MongoClient, config: Config): Promise<void> => {
  const db = mongo.db(config.database);

  for (const table of SYMBOL_TIMESTAMP_TABLES) {
    await db.collection(table).createIndex({ symbol: 1, timestamp: 1 });
  }

  await db.collection('insurance').createIndex({ currency: 1, timestamp: 1 });

  logger.info({ tables: SYMBOL_TIMESTAMP_TABLES.length + 1 }, 'Indexes ensured');
};
