import { seed } from './seeds/seed';
import type { Migration } from '../../types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 7 → 8. The eight shapes binance stopped writing, carrying the date each
 * stopped — which a walk finds the last file of but cannot tell from a gap.
 *
 * **`bookTicker` and `liquidationSnapshot` ended, cleanly and per service.**
 * Every USDⓈ-margined symbol's last file is 2024-03-30 for quotes and
 * 2024-03-31 for liquidations; every coin-margined one's is 2024-10-02 and
 * 2024-10-14. A cliff shared by every symbol of a service is a product
 * decision, not an outage, and nothing has been written to either tree since.
 *
 * **`EOHSummary` ran five months.** An end-of-hour summary of the options
 * market, one file a day for each of five underlyings, from 2023-05-18 to
 * 2023-10-23. Five series in total, and no sixth ever appeared.
 *
 * **The files stay; only the asking stops.** None of these is derivable from
 * anything else the venue publishes — best bid and ask at every update, forced
 * liquidations, and an option summary have no source but themselves — so they
 * are catalogued, downloaded and served exactly as before. What retiring them
 * ends is generation: an instrument binance still lists keeps its shapes open
 * for ever, and 458 series of these were spending fifteen probes a night each
 * on days that cannot exist.
 *
 * **Retired, not refused.** The opposite decision was taken for the `1w`, `3d`
 * and `1mo` intervals, which `accepts` drops outright — those are an aggregate
 * of a `1m` variant the catalog already holds, so there is nothing to keep.
 * These carry data that exists nowhere else.
 */
export const binanceRetirements: Migration = {
  name:     'binance',
  seedData: true,
  run:      (db: DatabaseSync) => seed(db, 'binance'),
};
