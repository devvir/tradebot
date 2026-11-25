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
 * the same `404` — so the shapes under `data/` are planted here carrying
 * the date they stopped, and the walk meets them already in place.
 *
 * **2026-08-04**, the day `data/` was last written; `historical_data/` began
 * beside it on 2026-02-01 (see `docs/venues/HTX.md`). Declared, because it is
 * not inferable.
 */
export const htxRetirements: Migration = {
  name:     'htx',
  seedData: true,
  run:      (db: DatabaseSync) => seed(db, 'htx'),
};
