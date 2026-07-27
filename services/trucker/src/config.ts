import { logger } from '@devvir/service-kit';
import { VENUE_NAMES } from './venues';
import type { Config } from './types';

/**
 * Container paths are fixed and private; the host directories behind them are
 * chosen by the compose mounts, which may put them on separate volumes or
 * separate machines. Nothing in here knows or needs to know where they land.
 *
 * Two of them, because trucker owns one directory and publishes into another:
 *
 * - **`/data/trucker`** — everything trucker collects, plus the bookkeeping it
 *   keeps about its own progress. Trucker's alone to read and write.
 * - **`/data/shared`** — the facts other services act on: which months
 *   are complete, and where a venue has rewritten history it already published.
 *   Shared by topic rather than by producer, since they describe the *venue's*
 *   archive rather than anything about trucker.
 *
 * `TRUCKER_DIR` and `TRUCKER_SHARED_DIR` exist only so the service can be run
 * outside a container during development.
 */
const CONTAINER_DATA_DIR   = '/data/trucker';
const CONTAINER_SHARED_DIR = '/data/shared';

const loadConfig = (): Config => {
  const startMonth = parseMonth(process.env.TRUCKER_START_MONTH, 'TRUCKER_START_MONTH');

  // Held as configured rather than resolved here. What an unset ceiling means —
  // the last complete month — moves with the calendar, and this service runs
  // for weeks, so it is worked out per sweep instead. See `limit` in sync.ts.
  const endMonth = parseMonth(process.env.TRUCKER_END_MONTH, 'TRUCKER_END_MONTH');

  if (startMonth && endMonth && startMonth > endMonth)
    throw new Error(`TRUCKER_END_MONTH (${endMonth}) is before TRUCKER_START_MONTH (${startMonth})`);

  const config: Config = {
    dataDir:     process.env.TRUCKER_DIR        ?? CONTAINER_DATA_DIR,
    sharedDir:   process.env.TRUCKER_SHARED_DIR ?? CONTAINER_SHARED_DIR,
    venues:      parseVenues(process.env.TRUCKER_VENUES),
    startMonth,
    endMonth,
    concurrency: parsePositiveInt(process.env.TRUCKER_CONCURRENCY, 4),
    rescanHours: parsePositiveInt(process.env.TRUCKER_RESCAN_HOURS, 6),
    symbols:     parseList(process.env.TRUCKER_SYMBOLS),
    minFreeGb:   parsePositiveInt(process.env.TRUCKER_MIN_FREE_GB, 50),
  };

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

const parseVenues = (raw: string | undefined): string[] => {
  const tokens = (raw ?? '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  const names  = tokens.length === 0 ? [...VENUE_NAMES] : tokens;

  for (const name of names) {
    if (! VENUE_NAMES.includes(name))
      throw new Error(`TRUCKER_VENUES: unknown venue "${name}". Valid: ${VENUE_NAMES.join(', ')}`);
  }

  return [...new Set(names)];
};

/**
 * Symbol tokens, matched case-insensitively as substrings. Venue naming differs
 * too much for exact lists to be portable — `BTC` selects `BTCUSDT`, `BTC_USDT`
 * and `BTC-USDT-SWAP` alike. Empty means every symbol the venue publishes,
 * which across five venues is more data than any single disk holds.
 */
const parseList = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map(t => t.trim().toUpperCase()).filter(Boolean);

/**
 * A month bound, as `yyyy-mm`, `yyyymm` or `yymm`.
 *
 * Months rather than dates because a date is ambiguous here and a month is not.
 * A ceiling has to land on a month boundary regardless — a monthly file is
 * keyed by its last day, so a mid-month cut either takes a month only partly
 * wanted or drops days already past — which left the old date form quietly
 * snapping to somewhere the caller did not name. `2026-03` says exactly what it
 * does, in three months' time as much as today.
 *
 * Both bounds are **inclusive**: `TRUCKER_START_MONTH=2019-01` fetches from
 * 1 January 2019, and `TRUCKER_END_MONTH=2019-12` through 31 December 2019.
 */
const parseMonth = (raw: string | undefined, name: string): string | null => {
  if (! raw?.trim()) return null;

  const digits = raw.trim().replace(/[-/]/g, '');

  // Length alone separates the two year forms; nothing else is accepted.
  if (! /^\d{6}$/.test(digits) && ! /^\d{4}$/.test(digits))
    throw new Error(`${name} must be yyyy-mm, yyyymm or yymm, got: ${raw}`);

  const month = digits.length === 4 ? `20${digits}` : digits;

  if (month.slice(4) < '01' || month.slice(4) > '12')
    throw new Error(`${name} names month ${month.slice(4)}, got: ${raw}`);

  return month;
};

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  if (! raw?.trim()) return fallback;

  const n = parseInt(raw, 10);

  if (! Number.isInteger(n) || n <= 0)
    throw new Error(`Expected a positive integer, got: ${raw}`);

  return n;
};

export default loadConfig();

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_parseVenues = parseVenues;
export const _test_parseList   = parseList;
export const _test_parseMonth  = parseMonth;
