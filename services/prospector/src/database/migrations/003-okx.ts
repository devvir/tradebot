import { seed } from './seeds/seed';
import type { Migration } from '../../types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 2 → 3. What okx publishes.
 *
 * **Nothing about okx can be discovered.** Its CDN, its OSS origin and its
 * website endpoint all refuse `ListObjects`, so there is no keyspace to walk and
 * never was: every key it serves is one this service constructs from a series it
 * already holds. Which means the series have to come from somewhere, and this is
 * where.
 *
 * The rows live in `seeds/okx/` and the reading of them is shared with every
 * other venue in the same position — see `seeds/README.md`.
 */
export const okxSeries: Migration = {
  name:     'okx',
  seedData: true,
  run:      (db: DatabaseSync) => seed(db, 'okx'),
};
