import { registry, SK_PROVIDERS } from '@devvir/service-kit';
import type { RedisClient } from '@devvir/service-kit';
import type { TardyTable } from './types';

/**
 * Persistent download progress for tardy: a per-table high-water mark holding
 * the last first-of-month date (YYYYMMDD) fully downloaded and closed for that
 * table. Callers ask for progress to be fetched or saved and never learn how
 * it is stored — redis today, anything else tomorrow, all hidden in here.
 *
 * Downloads run in ascending date order, so the mark only ever moves forward;
 * any target date <= the mark is already done and can be skipped without ever
 * touching vault (whose files are cold-storaged and removed once processed).
 */

const redis = (): RedisClient =>
  registry.get('tardy', SK_PROVIDERS).get('redis') as RedisClient;

const key = (table: TardyTable): string => `tardy:${table}`;

/** The last fully-complete date for a table, or null if none recorded yet. */
export const getProgress = async (table: TardyTable): Promise<string | null> =>
  redis().get(key(table));

/** Records `date` as the last fully-complete date for a table. */
export const setProgress = async (table: TardyTable, date: string): Promise<void> => {
  await redis().set(key(table), date);
};
