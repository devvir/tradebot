import { logger } from '@devvir/service-kit';
import type { Config } from './types.js';

function loadConfig(): Config {
  const config: Config = {
    database: process.env.REGISTRY_DATABASE || 'tradebot_registry',
  };

  logger.info(config, 'Configuration loaded and validated!');

  return config;
}

export default loadConfig();
