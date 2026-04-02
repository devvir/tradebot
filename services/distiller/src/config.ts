import { logger } from '@devvir/service-kit';
import type { Config } from './types';

const loadConfig = (): Config => {
  const config: Config = {
    database: process.env.DB_DATABASE ?? '',
  };

  if (! config.database)
    throw new Error('DB_DATABASE is required');

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

export default loadConfig();
