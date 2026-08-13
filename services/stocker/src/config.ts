import { logger } from '@devvir/service-kit';
import { SERIES } from './schema/series';
import { TABLES } from './schema/tables';
import type { Config } from './types';

/**
 * Container paths are fixed and private; the host directories behind them are
 * chosen by the compose mounts, which may put them on separate volumes or
 * separate machines. `STOCKER_*_DIR` exist only so the service can run outside
 * a container during development.
 *
 * Two of the three are mounted read-only, which is the ownership rule made
 * mechanical rather than conventional: trucker's archives are trucker's, and
 * `@shared` is written by whoever produced the fact. Stocker reads
 * both and writes neither.
 *
 * Trucker's directory is named for its owner in both worlds — `TRUCKER_DATA_DIR`
 * on the host, `/data/trucker` in the container — because reading someone
 * else's directory should look like exactly that at every layer.
 */
const CONTAINER_TRUCKER_DIR = '/data/trucker';
const CONTAINER_VAULT_DIR   = '/data/vault';
const CONTAINER_SHARED_DIR  = '/data/shared';

const loadConfig = (): Config => {
  const startMonth = parseMonth(process.env.STOCKER_START_MONTH, 'STOCKER_START_MONTH');
  const endMonth   = parseMonth(process.env.STOCKER_END_MONTH,   'STOCKER_END_MONTH');

  if (startMonth && endMonth && startMonth > endMonth)
    throw new Error(`STOCKER_END_MONTH (${endMonth}) is before STOCKER_START_MONTH (${startMonth})`);

  const config: Config = {
    truckerDir:  process.env.TRUCKER_DATA_DIR   ?? CONTAINER_TRUCKER_DIR,
    vaultDir:    process.env.STOCKER_VAULT_DIR  ?? CONTAINER_VAULT_DIR,
    sharedDir:   process.env.STOCKER_SHARED_DIR ?? CONTAINER_SHARED_DIR,
    venues:      parseKnown(process.env.STOCKER_VENUES, 'STOCKER_VENUES', VENUES),
    tables:      parseKnown(process.env.STOCKER_TABLES, 'STOCKER_TABLES', TABLE_NAMES),
    symbols:     parseList(process.env.STOCKER_SYMBOLS),
    startMonth,
    endMonth,
    concurrency: parsePositiveInt(process.env.STOCKER_CONCURRENCY, 2),
    scanMinutes: parsePositiveInt(process.env.STOCKER_SCAN_MINUTES, 30),
    threads:     parsePositiveInt(process.env.STOCKER_THREADS, 4),
  };

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

/** Symbol tokens: an open vocabulary, matched later as substrings. */
const parseList = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map(t => t.trim()).filter(Boolean);

/** Everything the series map knows, which is everything a filter could select. */
const VENUES      = [...new Set(SERIES.map(s => s.venue))].sort();
const TABLE_NAMES = Object.keys(TABLES).sort();

/**
 * Venue and table tokens against their closed vocabularies, case-insensitively,
 * returned in canonical spelling.
 *
 * These are unlike the symbol filter: symbols are an open set where matching
 * nothing is a normal answer, but every venue and table stocker will ever see
 * is declared in the series map — so a token outside it can never match, and
 * accepting it turns a typo (`BINANCE`, `orderbook`) into an eternally clean
 * run of zero partitions. Rejecting it at startup is the difference between a
 * filter and a silence.
 */
const parseKnown = (raw: string | undefined, name: string, known: string[]): string[] => {
  const canonical = new Map(known.map(k => [k.toLowerCase(), k]));

  const tokens = parseList(raw).map(token => {
    const match = canonical.get(token.toLowerCase());

    if (! match)
      throw new Error(`${name}: unknown token "${token}". Valid: ${known.join(', ')}`);

    return match;
  });

  return [...new Set(tokens)];
};

/**
 * A month bound, as `yyyy-mm`, `yyyymm` or `yymm` — the forms trucker takes, so
 * the two ends of the pipeline are configured the same way.
 *
 * **Months rather than dates, and both bounds inclusive.** A partition covers a
 * whole month, so a bound landing mid-month either takes a month only partly
 * wanted or drops days already past. `2026-03` says exactly what it does, in
 * three months' time as much as today.
 *
 * Returned dashed, which is the form partitions are keyed by here — so what a
 * person types and what the comparison uses need not be the same thing.
 *
 * Bounds scope a run to a slice that can then be confirmed, backed up and
 * reclaimed. The running month is excluded separately regardless, since its raw
 * is still arriving.
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

  return `${month.slice(0, 4)}-${month.slice(4)}`;
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

export const _test_parseList  = parseList;
export const _test_parseKnown = parseKnown;
export const _test_parseMonth = parseMonth;
