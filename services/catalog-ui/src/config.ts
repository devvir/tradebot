import { logger } from '@devvir/service-kit';
import type { Config } from './types';

/**
 * Where this service listens inside the container — fixed, like every other
 * service here. Which port the *host* publishes is the compose file's business,
 * and above 1024 because a container running as a non-root user cannot bind a
 * privileged one on every host.
 */
const CONTAINER_PORT = 8080;

/** Where the catalog answers inside the module's network, unless told otherwise. */
const CATALOG_API = 'http://catalog:8080';

/**
 * Where prospector's collector API answers. Private to the module network, so
 * it is a constant: nothing outside the module reaches it.
 */
const PROSPECTOR_API = 'http://prospector:8080';

/**
 * How long a forwarded request may wait for its answer. Above the catalog's
 * slowest answers, which run to tens of seconds; past it the page is told the
 * service did not answer.
 */
const UPSTREAM_TIMEOUT_MS = 120_000;

/** `CATALOG_UI_HOSTS`, comma-separated and lower-cased. Empty means any `Host` is served. */
const hostsOf = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map(one => one.trim().toLowerCase()).filter(Boolean);

const loadConfig = (): Config => {
  const config: Config = {
    catalogApi:    (process.env['CATALOG_API']?.trim() || CATALOG_API).replace(/\/$/, ''),
    prospectorApi: PROSPECTOR_API,
    catalogToken:  (process.env['CATALOG_TOKEN'] ?? '').trim(),
    allowedHosts:  hostsOf(process.env['CATALOG_UI_HOSTS']),
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
    port:         CONTAINER_PORT,
  };

  logger.info({
    ...config,
    catalogToken: config.catalogToken ? '<set>' : '<open>'
  }, 'Configuration loaded and validated!');

  return config;
};

export default loadConfig();
