import { logger } from '@devvir/service-kit';
import { SERIES } from './schema/series';
import type { Config } from './types';

/**
 * Container paths are fixed and private; the host directories behind them are
 * chosen by the compose mounts. `DATA_ARCHIVES_DIR` and `DATA_VAULT_DIR`
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
  const config: Config = {
    archivesDir:  process.env.DATA_ARCHIVES_DIR ?? CONTAINER_ARCHIVES_DIR,
    vaultDir:     process.env.DATA_VAULT_DIR    ?? CONTAINER_VAULT_DIR,
    catalogApi:   (process.env.CATALOG_API?.trim() || CATALOG_API).replace(/\/$/, ''),
    catalogToken: (process.env.CATALOG_TOKEN ?? '').trim(),
    lens:         (process.env.STOCKER_LENS ?? '').trim(),
    venues:       parseKnown(process.env.STOCKER_VENUES, 'STOCKER_VENUES', VENUES),
    concurrency:  parsePositiveInt(process.env.STOCKER_CONCURRENCY, 2),
    threads:      parsePositiveInt(process.env.STOCKER_THREADS, 4),
    minFreeGb:    parsePositiveInt(process.env.STOCKER_MIN_FREE_GB, 20),
    memoryGb:     parsePositiveInt(process.env.STOCKER_ENGINE_MEMORY_GB, 4),
  };

  logger.info({ ...config, catalogToken: config.catalogToken ? '<set>' : '<none>' },
    'Configuration loaded and validated!');

  return config;
};

/** A comma-separated list, trimmed, without its empty entries. */
const parseList = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map(t => t.trim()).filter(Boolean);

/** Every venue the series map knows, which is every venue a filter could select. */
const VENUES = [...new Set(SERIES.map(s => s.venue))].sort();

/**
 * Tokens against a closed vocabulary, case-insensitively, returned in canonical
 * spelling.
 *
 * Every venue stocker will ever see is declared in the series map — so a token
 * outside it can never match, and accepting it turns a typo (`BINANSE`) into an
 * eternally clean run of zero partitions. Rejecting it at startup is the
 * difference between a filter and a silence.
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
