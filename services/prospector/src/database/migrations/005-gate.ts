import { seed } from './seeds/seed';
import type { Migration } from '../../types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 4 → 5. The shapes gate filed under a month they do not belong to, each
 * carrying the one day it holds — which is the one thing a walk cannot work out
 * for itself.
 *
 * **Shapes only, and every one already finished.** Each pattern in `seeds/gate/`
 * keeps its month directory literal, because no date turns `{YYYY}{MM}` into a
 * month other than the stamp's: the three `orderbooks/202212/` shapes, holding
 * 2022-11-30 23:00, and the eighteen `candlesticks_{30s,1m,5m}/2024{07..12}/`
 * shapes, each holding the last day of the month before. Seeding them retired at
 * that day means a walk meets them already in place and already finished, so
 * nothing ever generates a key for them again.
 *
 * What gate misfiled, and which of it is the only copy, is in
 * `docs/venues/GATE.md`.
 */
export const gateMisfiled: Migration = {
  name:     'gate',
  seedData: true,
  run:      (db: DatabaseSync) => seed(db, 'gate'),
};
