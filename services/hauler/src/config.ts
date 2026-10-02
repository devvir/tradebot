import { logger } from '@devvir/service-kit';
import type { Config } from './types';

/**
 * The archives' fixed path inside the container; which host directory sits
 * behind it is the compose file's business.
 */
const ARCHIVES_DIR = '/data/archives';

const loadConfig = (): Config => {
  const config: Config = {
    archivesDir:  ARCHIVES_DIR,
    catalogUrl:   requiredEnv('CATALOG_URL').replace(/\/$/, ''),
    catalogToken: (process.env['CATALOG_TOKEN'] ?? '').trim(),
    venues:       parseList(process.env['HAULER_VENUES']),
    lens:         (process.env['HAULER_LENS'] ?? '').trim(),
    concurrency:  parsePositiveInt(process.env['HAULER_CONCURRENCY'], 8),
  };

  logger.info({ ...config, catalogToken: config.catalogToken ? '<set>' : '<none>' },
    'Configuration loaded and validated!');

  return config;
};

const requiredEnv = (name: string): string => {
  const value = process.env[name]?.trim();

  if (! value) throw new Error(`${name} is required — hauler cannot reach the catalog without it`);

  return value;
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
