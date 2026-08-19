import { seed } from './seeds/seed';
import type { Migration } from '../../types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 3 → 4. What bitget publishes.
 *
 * **Its bucket will not admit what it does not have.** It grants `GetObject` and
 * not `ListBucket`, so there is no listing to walk and a key it has never held
 * answers `403` — the same as being turned away. Nothing about this archive can
 * be found by looking at it, so the series arrive here instead.
 *
 * The rows live in `seeds/bitget/` and the reading of them is shared with every
 * other venue in the same position — see `seeds/README.md`.
 */
export const bitgetSeries: Migration = {
  name:     'bitget',
  seedData: true,

  run: (db: DatabaseSync) => seed(db, 'bitget'),
};
