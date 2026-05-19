import { type MongoClient } from 'mongodb';
import { logger } from '@devvir/service-kit';
import { enqueue } from './buffer';
import { TABLE_HANDLERS } from '../tables';
import * as clock from '../clock';
import type { BitmexTable, Config, MongoDoc, TableBuffer } from '../types';

/**
 * Fills and refills buffers from MongoDB. Pages by `_id` after the first fetch
 * (uses the default `_id` index — O(log n)). The first fetch seeks to the
 * current replay clock position.
 *
 * The clock is the single source of truth for "where are we" in replay. Each
 * subscription's first fetch seeds from `clock.fetch()`; subsequent fetches
 * page forward by `_id` cursor.
 */

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initial blocking fill. Run once after creating a buffer so the stream loop
 * has data to draw from immediately. The buffer's `cursor` may already be set
 * by the partial backfill (see commands/backfill.ts) — in which case we page
 * forward from it instead of seeking by clock.
 */
export const initialFill = async (
  buffer: TableBuffer,
  config: Config,
  mongo:  MongoClient,
): Promise<void> => {
  if (buffer.cursor === null && clock.fetch() === null) return;

  buffer.isFetching = true;

  const docs = await query(buffer, config, mongo);

  enqueue(buffer, docs);
  finalizeFetch(buffer, docs, config);
};

/**
 * Trigger a background refill. Idempotent — no-op if a fetch is already in
 * flight. Errors clear `isFetching` so the next watermark check can retry.
 */
export const triggerFetch = (
  buffer: TableBuffer,
  config: Config,
  mongo:  MongoClient,
): void => {
  if (buffer.isFetching) return;

  if (buffer.cursor === null && clock.fetch() === null) return;

  buffer.isFetching = true;

  fetchNext(buffer, config, mongo).catch((err) => {
    logger.error({ err, table: buffer.table }, 'Fetch failed');
    buffer.isFetching = false;
  });
};

// ── Internal ──────────────────────────────────────────────────────────────────

const fetchNext = async (
  buffer: TableBuffer,
  config: Config,
  mongo:  MongoClient,
): Promise<void> => {
  const docs = await query(buffer, config, mongo);

  enqueue(buffer, docs);
  finalizeFetch(buffer, docs, config);
};

const finalizeFetch = (buffer: TableBuffer, docs: MongoDoc[], config: Config): void => {
  if (docs.length < config.bufferBatchSize) {
    buffer.exhausted = true;
    logger.debug({ table: buffer.table }, 'Buffer exhausted — no more data upstream');
  }

  if (docs.length > 0) {
    buffer.cursor = docs[docs.length - 1]._id;
  }

  buffer.isFetching = false;
};

const query = async (
  buffer: TableBuffer,
  config: Config,
  mongo:  MongoClient,
): Promise<MongoDoc[]> => {
  const handler    = TABLE_HANDLERS[buffer.table as BitmexTable];
  const origin     = handler?.origin ?? 'rest';
  const collection = mongo.db(config.database).collection<MongoDoc>(buffer.table);
  const filter     = buildFilter(buffer, origin);

  const docs = await collection
    .find(filter)
    .sort({ _id: 1 })
    .limit(config.bufferBatchSize)
    .toArray();

  return docs as MongoDoc[];
};

/**
 * After the first fetch we always page by `_id` cursor. The first fetch seeks:
 *
 *   rest-origin → exact `timestamp >= clock` (cheap with the symbol+timestamp index).
 *   ws-origin   → minimum `_id` for the calendar day containing `clock` (the
 *                 day-aligned `_id` encoding makes this O(log n)).
 *                 The stream may emit a few messages slightly before `clock`; that's
 *                 fine because the snapshot at `clock` already covers earlier state.
 */
const buildFilter = (
  buffer: TableBuffer,
  origin: 'ws' | 'rest',
): Record<string, unknown> => {
  if (buffer.cursor !== null) {
    return { _id: { $gt: buffer.cursor } };
  }

  const seek = clock.fetch();

  if (seek === null) {
    throw new Error('Replay clock not set — call POST /set-clock or set DIGGER_START_TIME');
  }

  if (origin === 'rest') {
    return { timestamp: { $gte: new Date(seek).toISOString() } };
  }

  return { _id: { $gte: minIdForDate(seek) } };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const EPOCH_2000_MS = Date.UTC(2000, 0, 1);
const MS_PER_DAY    = 86_400_000;
const SHIFT_39      = 549_755_813_888;

/** First `_id` value possible for the calendar day containing `epochMs`. */
const minIdForDate = (epochMs: number): number =>
  Math.floor((epochMs - EPOCH_2000_MS) / MS_PER_DAY) * SHIFT_39;

// ── Test-only ─────────────────────────────────────────────────────────────────

export const _test_buildFilter = buildFilter;
