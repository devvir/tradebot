/**
 * Forensic write path for items the pipeline couldn't process. Used when
 * `JSON.parse` or `reconstruct()` throws — bytes were corrupted between
 * vault and farmer somewhere, and we preserve the raw NDJSON line in the
 * `farmer.<table>` collection with the `_id` it would have had in the
 * main `tradebot.<table>` collection.
 *
 * Writes are immediate `insertOne`s — no batching, no timers. The error
 * path is expected to be rare; the simplicity wins.
 */

import { logger, registry, type MongoClient } from '@devvir/service-kit';
import { makeId } from './id';
import type { BitmexTable } from '@tradebot/types';

const ERROR_DB = 'farmer';

export const recordError = async (
  table:    BitmexTable,
  date:     string,
  position: number,
  raw:      string,
): Promise<void> => {
  const mongo = registry.get('farmer').providers.get('mongodb') as MongoClient;

  try {
    await mongo.db(ERROR_DB).collection(table).insertOne({
      _id:     makeId(date, position),
      message: raw,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  } catch (err) {
    /**
     * If the error doc itself is already there (E11000), we've seen the
     * same corruption before — nothing to do, swallow silently. Anything
     * else gets logged but not re-thrown: we don't want to derail the
     * pipeline for a forensic write.
     */
    if (! isDuplicateKey(err)) {
      logger.error({ err, table, date, position }, 'Failed to record error doc');
    }
  }
};

const isDuplicateKey = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;

// ── Test-only exports ─────────────────────────────────────────────────────────

export const _test_ERROR_DB = ERROR_DB;
