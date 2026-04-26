import { logger } from '@devvir/service-kit';
import type { Collection, MongoClient } from 'mongodb';
import * as snapshots from '../snapshots';
import { wsPayload, timestampFromId } from '../tables/handler';
import type { BitmexTable, Config, MongoDoc, TableBuffer } from '../types';

/**
 * Cold-subscribe partial reconstruction for WS-origin tables.
 *
 * Live BitMEX always sends a `partial` message immediately after a subscribe,
 * carrying the schema and current state. Replay must do the same. The replay
 * stream feeds the snapshots accumulator as it runs, so warm tables already
 * have a current state — no backfill needed. Cold tables (first subscribe of
 * the session, or right after `set-clock`) need explicit seeding.
 *
 * Algorithm — at clock position X:
 *   1. Find the most recent stored partial whose timestamp ≤ X.
 *   2. Apply that partial to the snapshots accumulator.
 *   3. Apply every delta between the partial and X (in `_id` order).
 *   4. Snapshots now reflects the full state at X — caller reads it via
 *      `snapshots.buildSnapshot(table)` and publishes it as the partial.
 *
 * Side effect: `buffer.cursor` is set to the highest `_id` we processed, so
 * the first stream fetch starts strictly after X — no double-publishing of
 * the deltas we used for the snapshot.
 *
 * REST-origin tables don't have stored partials (they're flat record streams).
 * They use the static partial declared on the handler — no backfill needed.
 *
 * WS partials happen at every BitMEX reconnect (roughly hourly), so a partial
 * within at most a couple of days of any X is essentially guaranteed.
 */

const EPOCH_2000_MS = Date.UTC(2000, 0, 1);
const MS_PER_DAY    = 86_400_000;
const SHIFT_39      = 549_755_813_888;

/** How many recent partials to scan before giving up. ~1 per reconnect (~1h). */
const PARTIAL_SCAN_LIMIT = 100;

/** Hard cap on docs fed to the accumulator during a single backfill. */
const DELTA_FETCH_LIMIT  = 50_000;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Seed the snapshots accumulator for `table` with state at clock position `X`.
 * Returns true when a partial was found and applied; false when no stored
 * partial exists before X (rare — only at the very beginning of recorded data).
 *
 * Caller is responsible for publishing the resulting snapshot via
 * `snapshots.buildSnapshot(table)` and `publishPartial`.
 */
export const backfillSnapshot = async (
  table:  BitmexTable,
  X:      number,
  buffer: TableBuffer,
  config: Config,
  mongo:  MongoClient,
): Promise<boolean> => {
  const collection = mongo.db(config.database).collection<MongoDoc>(table);
  const partialDoc = await findLatestPartial(collection, X);

  if (! partialDoc) {
    logger.warn({ table, X }, 'Backfill: no stored partial found before clock');
    return false;
  }

  snapshots.feed(wsPayload(table, partialDoc));

  const lastId = await applyDeltasUpTo(collection, table, partialDoc._id, X);

  buffer.cursor = lastId;

  return true;
};

// ── Internal ──────────────────────────────────────────────────────────────────

/**
 * Find the most recent stored partial whose data timestamp ≤ X.
 *
 * The stored doc's `_id` is day-aligned (registrar's encoding). To bound the
 * MongoDB scan we limit by `_id < firstIdAfterDay(X)`, then walk descending
 * results checking each doc's data[0].timestamp against X.
 */
const findLatestPartial = async (
  collection: Collection<MongoDoc>,
  X:          number,
): Promise<MongoDoc | null> => {
  const candidates = await collection
    .find({ action: 'partial', _id: { $lt: firstIdAfterDay(X) } })
    .sort({ _id: -1 })
    .limit(PARTIAL_SCAN_LIMIT)
    .toArray();

  for (const doc of candidates) {
    if (timestampFor(doc) <= X) return doc;
  }

  return null;
};

/**
 * Feed every delta between the partial doc and X into the snapshots
 * accumulator, in `_id` order. Returns the last `_id` we processed (or the
 * partial's own `_id` if no deltas).
 */
const applyDeltasUpTo = async (
  collection: Collection<MongoDoc>,
  table:      BitmexTable,
  partialId:  number,
  X:          number,
): Promise<number> => {
  const docs = await collection
    .find({ _id: { $gt: partialId, $lt: firstIdAfterDay(X) } })
    .sort({ _id: 1 })
    .limit(DELTA_FETCH_LIMIT)
    .toArray();

  let lastId = partialId;

  for (const doc of docs) {
    if (timestampFor(doc) > X) break;

    snapshots.feed(wsPayload(table, doc));
    lastId = doc._id;
  }

  return lastId;
};

/** Best-effort timestamp for a stored WS-origin doc. */
const timestampFor = (doc: MongoDoc): number => {
  const data = doc.data as Array<Record<string, unknown>> | undefined;
  const ts   = data?.[0]?.timestamp as string | undefined;

  return ts ? new Date(ts).getTime() : timestampFromId(doc);
};

/** First `_id` value possible for the calendar day AFTER the day containing `epochMs`. */
const firstIdAfterDay = (epochMs: number): number =>
  (Math.floor((epochMs - EPOCH_2000_MS) / MS_PER_DAY) + 1) * SHIFT_39;

// ── Test-only ─────────────────────────────────────────────────────────────────

export const _test_timestampFor    = timestampFor;
export const _test_firstIdAfterDay = firstIdAfterDay;
