import { logger } from '@devvir/service-kit';
import { DATASETS, MARKETS } from './types';
import type { Config } from './types';

/**
 * The container paths are fixed and private; which host directories sit behind
 * them is the compose mount's business, and nothing here knows or needs to.
 *
 * Two directories, because hauler owns two things that are not the same kind of
 * thing: the archives it fills, and the facts database it states one fact into.
 * The catalog is neither — it is reached over HTTP, and is expected to live on
 * whichever machine has the good link rather than on the one with the disk.
 */
const ARCHIVES_DIR = '/data/archives';
const SHARED_DIR   = '/data/shared';

/**
 * Where the shopping-list API listens inside the container — fixed, like the
 * paths above. Which port the *host* publishes it on is the compose file's
 * business, and above 1024 because a container running as a non-root user
 * cannot bind a privileged one on every host.
 */
const CONTAINER_PORT = 8080;

const loadConfig = (): Config => {
  const config: Config = {
    archivesDir: ARCHIVES_DIR,
    sharedDir:   SHARED_DIR,
    catalogUrl:  requiredEnv('CATALOG_URL').replace(/\/$/, ''),
    catalogToken: (process.env['CATALOG_TOKEN'] ?? '').trim(),
    port:         CONTAINER_PORT,
    venues:      parseList(process.env.HAULER_VENUES),
    markets:     parseCanonical('HAULER_MARKETS', process.env.HAULER_MARKETS, MARKETS),
    datasets:    parseCanonical('HAULER_DATASETS', process.env.HAULER_DATASETS, DATASETS),
    ...optionally('from', parseMonth('HAULER_FROM', process.env.HAULER_FROM)),
    ...optionally('to', parseMonth('HAULER_TO', process.env.HAULER_TO)),
    concurrency: parsePositiveInt(process.env.HAULER_CONCURRENCY, 8),
  };

  logger.info({ ...config, catalogToken: config.catalogToken ? '<set>' : '<open>' },
    'Configuration loaded and validated!');

  /**
   * **An open deployment is a choice, so it is stated loudly rather than
   * assumed.** A blank token means this sends none to the catalog and checks
   * none on its own shopping list — fine where nothing else can reach either
   * port, and a mistake anywhere they are.
   */
  if (! config.catalogToken)
    logger.warn('CATALOG_TOKEN is empty — the catalog is asked without one, '
      + 'and the shopping-list API is open to anyone who can reach the port');

  return config;
};

/**
 * A value the service cannot invent a default for.
 *
 * **Only the address is one.** A wrong guess at where the catalog lives is a
 * hauler that starts cleanly and downloads nothing, which is far worse than one
 * that refuses to start. The token is not: empty is a legitimate answer, meaning
 * an open catalog and an open shopping list, and it is warned about rather than
 * refused.
 */
const requiredEnv = (name: string): string => {
  const value = process.env[name]?.trim();

  if (! value) throw new Error(`${name} is required — hauler cannot reach the catalog without it`);

  return value;
};

/** A venue list, or empty for "every venue the catalog offers". */
const parseList = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map(token => token.trim().toLowerCase()).filter(Boolean);

/**
 * A market or dataset list, checked against the vocabulary rather than trusted.
 *
 * Wrong here means every want silently narrows to nothing rather than a clear
 * error, so it is caught at startup — the same reasoning `PUT /wanted` applies
 * to a want's own `market` and `dataset`.
 */
const parseCanonical = (name: string, raw: string | undefined, vocabulary: readonly string[]): string[] => {
  const values = parseList(raw);
  const unknown = values.filter(value => ! vocabulary.includes(value));

  if (unknown.length > 0)
    throw new Error(`${name}: '${unknown.join(', ')}' not in ${vocabulary.join(', ')}`);

  return values;
};

const parseMonth = (name: string, raw: string | undefined): string | undefined => {
  const value = raw?.trim();

  if (! value) return undefined;

  if (! /^\d{6}$/.test(value)) throw new Error(`${name} must be a yyyymm month, got '${value}'`);

  return value;
};

const optionally = (name: 'from' | 'to', value: string | undefined): Partial<Pick<Config, 'from' | 'to'>> =>
  value === undefined ? {} : { [name]: value };

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
export const _test_parseCanonical   = parseCanonical;
export const _test_parseMonth       = parseMonth;
export const _test_parsePositiveInt = parsePositiveInt;
