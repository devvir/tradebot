import { seed } from './seeds/seed';
import type { Migration } from '../../types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 5 → 6. The shapes binance stopped writing, each carrying the date it stopped —
 * which a walk finds the last file of but cannot tell from a gap.
 *
 * **Shapes only, retired at the dates recorded in `seeds/binance/`**: the
 * `bookTicker` and `liquidationSnapshot` trees of both futures services and the
 * options `EOHSummary`. When and how each ended is in `docs/venues/BINANCE.md`.
 *
 * **The files stay; only the asking stops.** None of these is derivable from
 * anything else the venue publishes — best bid and ask at every update, forced
 * liquidations, and an option summary have no source but themselves — so they
 * are catalogued, downloaded and served like any other. What retiring them ends
 * is generation: without it an instrument binance still lists keeps its shapes
 * open, and every pass asks for days that cannot exist.
 *
 * **Retired, not refused.** Paths the catalog never holds are the binance
 * adapter's `accepts`; these stay catalogued, and only their generation ends.
 */
export const binanceRetirements: Migration = {
  name:     'binance',
  seedData: true,
  run:      (db: DatabaseSync) => seed(db, 'binance'),
};
