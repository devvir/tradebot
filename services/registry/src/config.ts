import { logger } from '@devvir/service-kit';
import type { Config } from './types.js';

const HTTP_PORT = 80;

function loadConfig(): Config {
  const config: Config = {
    database: process.env.REGISTRY_DATABASE || 'tradebot_registry',
    httpPort: HTTP_PORT,
  };

  logger.info(config, 'Configuration loaded and validated!');

  return config;
}

export default loadConfig();
