/**
 * Read-only view of the customs pipeline progress for each (table, date).
 *
 * Registrar owns these keys — clerk never writes them. Each key
 * (`customs:<table>:<date>`) is one of:
 *
 *   - missing:           bucket has no progress yet (no message stored)
 *   - numeric string:    the highest msgIndex stored in MongoDB so far
 *   - `'done:<count>'`:  registrar has confirmed the whole bucket is stored;
 *                        `count` is the total number of messages in the bucket
 *
 * Clerk consults this to decide what to skip and where to resume from. The
 * `<count>` suffix is informational for other consumers — clerk only cares
 * whether the bucket is done.
 */

import type { RedisClient } from '@devvir/service-kit';

export type Progress =
  | { state: 'done' }
  | { state: 'pending'; startFrom: number };

const key = (table: string, date: string): string => `customs:${table}:${date}`;

/**
 * Reads the registrar-owned progress for a file. `startFrom` is the absolute
 * 0-based index of the next message clerk should request from vault — it is
 * `stored + 1` because `stored` was already inserted into MongoDB.
 */
export const readProgress = async (
  redis: RedisClient,
  table: string,
  date:  string,
): Promise<Progress> => {
  const val = await redis.get(key(table, date));

  if (val === null)           return { state: 'pending', startFrom: 0 };
  if (val.startsWith('done')) return { state: 'done' };

  const stored = parseInt(val, 10);

  return { state: 'pending', startFrom: stored + 1 };
};
