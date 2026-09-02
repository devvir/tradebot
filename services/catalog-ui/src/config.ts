import { logger } from '@devvir/service-kit';
import type { Config } from './types';

/**
 * Where this service listens inside the container — fixed, like every other
 * service here. Which port the *host* publishes is the compose file's business,
 * and above 1024 because a container running as a non-root user cannot bind a
 * privileged one on every host.
 */
const CONTAINER_PORT = 8080;

const loadConfig = (): Config => {
  const config: Config = {
    catalogUrl:   (process.env['CATALOG_URL'] ?? 'http://prospector:8080').replace(/\/$/, ''),
    catalogToken: (process.env['CATALOG_TOKEN'] ?? '').trim(),
    haulerUrl:    (process.env['HAULER_URL'] ?? '').replace(/\/$/, ''),
    port:         CONTAINER_PORT,
  };

  logger.info({
    ...config,
    catalogToken: config.catalogToken ? '<set>' : '<open>'
  }, 'Configuration loaded and validated!');

  return config;
};

export default loadConfig();
