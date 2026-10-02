import { logger } from '@devvir/service-kit';
import type { Config } from './types';

/**
 * The container paths are fixed and private; which host directory sits behind
 * the database is the compose mount's business.
 *
 * **The database is prospector's.** It creates it, migrates it and writes every
 * file into it; this service opens the same file to read it and to store lenses,
 * which is why the two must share a host — a SQLite database in WAL mode is
 * shared through memory, never over a network filesystem.
 */
const CATALOG_DB = '/data/catalog/catalog.db';

/** Where the API listens inside the container; the host port is the compose file's business. */
const CONTAINER_PORT = 8080;

/**
 * **Prospector is private**, reachable only on the module's own network, so its
 * address is a constant rather than a setting: nothing outside the module is
 * ever pointed at it.
 */
const PROSPECTOR_API = 'http://prospector:8080';

const loadConfig = (): Config => {
  const config: Config = {
    port:          CONTAINER_PORT,
    dbPath:        process.env['CATALOG_DB'] ?? CATALOG_DB,
    token:         (process.env['CATALOG_TOKEN'] ?? '').trim(),
    prospectorApi: PROSPECTOR_API,
  };

  // The token is the one value that must not reach a log.
  logger.info({ ...config, token: config.token ? '<set>' : '<open>' }, 'Configuration loaded and validated!');

  if (! config.token)
    logger.warn('CATALOG_TOKEN is empty — the API is open to anyone who can reach the port');

  return config;
};

export default loadConfig();
