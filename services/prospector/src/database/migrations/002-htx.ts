import { seed } from './seeds/seed';
import type { Migration } from '../../types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 1 → 2. When htx's old tree stopped, which is the one thing a walk cannot find
 * out for itself.
 *
 * **Shapes only, and only the dead ones.** htx is walked: its patterns and its
 * series arrive from reading the archive, and seeding them would be a stale copy
 * of what the first walk establishes anyway. What no amount of reading can
 * establish is that a tree has *ended* — a missing file and a finished tree are
 * the same `404` — so the ninety shapes under `data/` are planted here carrying
 * the date they stopped, and the walk meets them already in place.
 *
 * **2026-08-04.** htx moved to `historical_data/` on 2026-02-01 and wrote the
 * last of `data/` on that day. Declared, because it is not inferable.
 *
 * This replaced a pass that ran on every startup looking for the same shapes to
 * retire — data wearing the clothes of an update, which is what made its
 * effect depend on when it happened to run.
 */
export const htxRetirements: Migration = {
  name:     'htx',
  seedData: true,
  run:      (db: DatabaseSync) => seed(db, 'htx'),
};
