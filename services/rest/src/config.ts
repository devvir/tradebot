import { logger } from '@devvir/service-kit';
import type { Config } from './types';

const loadConfig = (): Config => {
  const config: Config = {
    dataUrl: process.env.REST_DATA_URL ?? '',
  };

  if (! config.dataUrl) throw new Error('REST_DATA_URL is required');

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

export default loadConfig();
