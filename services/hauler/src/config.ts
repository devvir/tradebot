import { logger } from '@devvir/service-kit';
import type { Config } from './types';

/**
 * The archives' fixed path inside the container; which host directory sits
 * behind it is the compose file's business.
 */
const ARCHIVES_DIR = '/data/archives';

/** Where the catalog answers inside the module's network. */
const CATALOG_API = 'http://catalog:8080';

const loadConfig = (): Config => {
  const config: Config = {
    archivesDir:  ARCHIVES_DIR,
    catalogApi:   (process.env['CATALOG_API']?.trim() || CATALOG_API).replace(/\/$/, ''),
    catalogToken: (process.env['CATALOG_TOKEN'] ?? '').trim(),
    venues:       parseList(process.env['HAULER_VENUES']),
    lens:         (process.env['HAULER_LENS'] ?? '').trim(),
    concurrency:  parsePositiveInt(process.env['HAULER_CONCURRENCY'], 100),
    minFreeGb:    parsePositiveInt(process.env['HAULER_MIN_FREE_GB'], 25),
  };

  logger.info({ ...config, catalogToken: config.catalogToken ? '<set>' : '<none>' },
    'Configuration loaded and validated!');

  return config;
};

const parseList = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map(token => token.trim().toLowerCase()).filter(Boolean);

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number(raw);

  if (! Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`Expected a positive integer, got "${raw}"`);

  return parsed;
};

export default loadConfig();

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_loadConfig       = loadConfig;
export const _test_parseList        = parseList;
export const _test_parsePositiveInt = parsePositiveInt;
