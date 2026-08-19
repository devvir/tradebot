import { binance } from './adapters/binance';
import { bitget } from './adapters/bitget';
import { bybitPrimary } from './adapters/bybit.primary';
import { bybitSecondary } from './adapters/bybit.secondary';
import { gate } from './adapters/gate';
import { htx } from './adapters/htx';
import { kucoin } from './adapters/kucoin';
import { okx } from './adapters/okx';
import type { Adapter } from './types';

/**
 * Every server the prospector can survey.
 *
 * Adding one is this line plus one file. A venue built on a platform already
 * represented — a standard S3 bucket, a browsable HTML index, a bucket that can
 * only be asked one key at a time — adds no scanner at all; a venue reachable
 * some other way adds a scanner beside `s3`, `html` and `probed`, named after
 * the shape of the thing rather than after the venue.
 *
 * **A venue may be registered before it is reachable**, so that adding one is
 * not all-or-nothing: its id, its `venue` row, its exclusions and its place in
 * configuration can land before anything can read it, wired to `scanners/none`
 * in the meantime. Every venue here has a real scanner today.
 *
 * **A venue may appear more than once.** Bybit publishes its order books on a
 * separate host with its own shape and its own limiter, so it is two adapters
 * sharing a name. Files are named for the pair they serve — `bybit.primary.ts`,
 * `bybit.secondary.ts` — but that is a convention for readers and nothing parses
 * it; the `host` on each adapter is what counts.
 */
const ADAPTERS: readonly Adapter[] = [
  binance, bybitPrimary, bybitSecondary, gate, htx, kucoin, okx, bitget,
];

/**
 * Give every adapter the address its `venue` row holds.
 *
 * **Called once, before anything surveys.** Where a venue is and what prefix it
 * is rooted at are application constants kept in the database so everything can
 * join against them — see the `venues` migration — and this is the one place
 * they cross back into code.
 *
 * A venue with no row is refused rather than left blank: an adapter with an
 * empty base would walk `/…` and read as a venue that publishes nothing, which
 * is the kind of silence this service is built to avoid.
 */
export const addressVenues = (rows: readonly VenueRow[]): void => {
  for (const adapter of ADAPTERS) {
    const row = rows.find(one =>
      one.name === adapter.name && one.host === (adapter.host ?? ''));

    if (! row)
      throw new Error(
        `No venue row for '${adapter.name}'${adapter.host ? ` (${adapter.host})` : ''}`
        + ' — every adapter needs one, and they come from the venues migration');

    adapter.base = row.base;
    adapter.root = row.root;
  }
};

/** What the `venue` table says about where a venue is. */
export interface VenueRow {
  name: string;
  host: string;
  base: string;
  root: string;
}

/** What a person may name in configuration: venues, not servers. */
export const VENUE_NAMES: readonly string[] = [...new Set(ADAPTERS.map(a => a.name))];

/**
 * Every adapter serving a venue.
 *
 * Naming a venue selects all of its hosts, because that is what a person means
 * by "survey bybit" — the split into servers is bybit's business, not theirs.
 */
export const adaptersForVenue = (name: string): Adapter[] => {
  const found = ADAPTERS.filter(a => a.name === name);

  if (found.length === 0)
    throw new Error(`Unknown venue '${name}' — known: ${VENUE_NAMES.join(', ')}`);

  return found;
};

export const adaptersFor = (names: readonly string[]): Adapter[] =>
  (names.length === 0 ? [...ADAPTERS] : names.flatMap(adaptersForVenue));

