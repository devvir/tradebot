import { logger } from '@devvir/service-kit';
import { SERIES } from './schema/series';
import { TABLES } from './schema/tables';
import type { Config } from './types';

/**
 * Container paths are fixed and private; the host directories behind them are
 * chosen by the compose mounts. `STOCKER_ARCHIVES_DIR` and `STOCKER_VAULT_DIR`
 * override them only so the service can run outside a container.
 *
 * The archives are mounted read-only: they are hauler's, and the mount makes
 * that mechanical rather than conventional.
 */
const CONTAINER_ARCHIVES_DIR = '/data/archives';
const CONTAINER_VAULT_DIR    = '/data/vault';

/** Where the catalog answers inside the shared network. */
const CATALOG_API = 'http://catalog:8080';

const loadConfig = (): Config => {
  const startMonth = parseMonth(process.env.STOCKER_START_MONTH, 'STOCKER_START_MONTH');
  const endMonth   = parseMonth(process.env.STOCKER_END_MONTH,   'STOCKER_END_MONTH');

  if (startMonth && endMonth && startMonth > endMonth)
    throw new Error(`STOCKER_END_MONTH (${endMonth}) is before STOCKER_START_MONTH (${startMonth})`);

  const config: Config = {
    archivesDir:  process.env.STOCKER_ARCHIVES_DIR ?? CONTAINER_ARCHIVES_DIR,
    vaultDir:     process.env.STOCKER_VAULT_DIR    ?? CONTAINER_VAULT_DIR,
    catalogApi:   (process.env.CATALOG_API?.trim() || CATALOG_API).replace(/\/$/, ''),
    catalogToken: (process.env.CATALOG_TOKEN ?? '').trim(),
    lens:         (process.env.STOCKER_LENS ?? '').trim(),
    venues:       parseKnown(process.env.STOCKER_VENUES, 'STOCKER_VENUES', VENUES),
    tables:       parseKnown(process.env.STOCKER_TABLES, 'STOCKER_TABLES', TABLE_NAMES),
    symbols:      parseList(process.env.STOCKER_SYMBOLS),
    startMonth,
    endMonth,
    concurrency:  parsePositiveInt(process.env.STOCKER_CONCURRENCY, 2),
    scanMinutes:  parsePositiveInt(process.env.STOCKER_SCAN_MINUTES, 30),
    threads:      parsePositiveInt(process.env.STOCKER_THREADS, 4),
    minFreeGb:    parsePositiveInt(process.env.STOCKER_MIN_FREE_GB, 20),
    memoryGb:     parsePositiveInt(process.env.STOCKER_MEMORY_GB, 4),
    splitGb:      parsePositiveInt(process.env.STOCKER_SPLIT_GB, 1),
    coolHours:    parsePositiveInt(process.env.STOCKER_COOL_HOURS, 1),
  };

  logger.info({ ...config, catalogToken: config.catalogToken ? '<set>' : '<none>' },
    'Configuration loaded and validated!');

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
 * A month bound, as `yyyy-mm`, `yyyymm` or `yymm`.
 *
 * **Months rather than dates, and both bounds inclusive.** A partition covers a
 * whole month, so a bound landing mid-month either takes a month only partly
 * wanted or drops days already past.
 *
 * Returned dashed, which is the form partitions are keyed by here.
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
