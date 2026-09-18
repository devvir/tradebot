import { seed } from './seeds/seed';
import type { Migration } from '../../types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 5 → 6. The three shapes gate used for exactly one hour, carrying the date they
 * stopped — which is the one thing a walk cannot work out for itself.
 *
 * **Gate filed the last hour of November 2022 into December's directory.** Every
 * one of these keys is `…/202212/{SYMBOL}-2022113023.csv.gz`: the month segment
 * says December and the file covers 23:00 on the 30th of November. It happened
 * once, at that boundary — every other month end has its 23rd hour in its own
 * directory — and it produced 3,152 files across spot, `futures_usdt` and
 * `futures_btc`, one per instrument.
 *
 * **They are the only copy of that hour**, which is why they are catalogued
 * rather than refused: the proper directory holds hours 00 to 22 of that day and
 * nothing more.
 *
 * **They cannot share the ordinary shape.** A pattern builds a URL from a date,
 * and no date turns `{YYYY}{MM}` into December while the stamp says November —
 * so path derivation keeps the month literal, correctly, and the instruments end
 * up with a second series holding one file each. Seeding the shapes here means a
 * walk meets them already in place and already finished, so nothing ever
 * generates a key for them again.
 *
 * Consumers see the split, and `docs/venues/GATE.md` is where that is written
 * down for them.
 */
export const gateMisfiled: Migration = {
  name:     'gate',
  seedData: true,
  run:      (db: DatabaseSync) => seed(db, 'gate'),
};
