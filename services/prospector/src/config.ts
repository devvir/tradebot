import { logger } from '@devvir/service-kit';
import { VENUE_NAMES } from './venues';
import type { Config } from './types';

/**
 * The container path is fixed and private; whichever host directory sits behind
 * it is the compose mount's business, and nothing here knows or needs to know
 * where it lands.
 *
 * One directory, because the prospector owns exactly one thing: the catalog it
 * writes. The facts database belongs to the archivist and is never opened here.
 */
const CATALOG_DIR = '/data/catalog';

/**
 * Where the API listens inside the container — fixed, like the path above.
 *
 * Which port the *host* publishes it on is the compose file's business, and
 * nothing in here knows or needs to know: two containers on one machine differ
 * in their mapping, not in what they run.
 *
 * **Above 1024 deliberately.** A container running as a non-root user cannot
 * bind a privileged port unless the host allows it, and not every host does —
 * so a low number here would work in one place and fail in another for a reason
 * that has nothing to do with this service.
 */
const CONTAINER_PORT = 8080;

const loadConfig = (): Config => {
  const config: Config = {
    catalogDir:  CATALOG_DIR,
    token:       (process.env['CATALOG_TOKEN'] ?? '').trim(),
    port:        CONTAINER_PORT,
    venues:      parseVenues(process.env.PROSPECTOR_VENUES),
    concurrency: parsePositiveInt(process.env.PROSPECTOR_CONCURRENCY, 200),
  };

  /**
   * The token is the one value here that must not reach a log. Everything else
   * is a setting somebody chose and will want to see confirmed; this is a
   * secret, and a log is copied, shipped and pasted into issues.
   */
  logger.info({ ...config, token: config.token ? '<set>' : '<open>' },
    'Configuration loaded and validated!');

  /**
   * **An open catalog is a choice, so it is stated loudly rather than assumed.**
   *
   * Leaving the token blank turns the check off entirely, which is what makes
   * the read endpoints reachable from a browser. That is a convenience for a
   * machine nobody else can reach, and a mistake anywhere the port is — so it
   * cannot happen quietly.
   */
  if (! config.token)
    logger.warn('CATALOG_TOKEN is empty — the API is open to anyone who can reach the port');

  return config;
};


const parseVenues = (raw: string | undefined): string[] => {
  const tokens = (raw ?? '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);

  for (const name of tokens) {
    if (! VENUE_NAMES.includes(name))
      throw new Error(`PROSPECTOR_VENUES: unknown venue "${name}". Valid: ${VENUE_NAMES.join(', ')}`);
  }

  return tokens;
};

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number(raw);

  if (! Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`Expected a positive integer, got "${raw}"`);

  return parsed;
};

export default loadConfig();

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_loadConfig      = loadConfig;
export const _test_parseVenues     = parseVenues;
export const _test_parsePositiveInt = parsePositiveInt;
