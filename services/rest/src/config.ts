import { logger } from '@devvir/service-kit';
import type { Config } from './types';

const loadConfig = (): Config => {
  const config = {
    snapshotsUrl: process.env.SNAPSHOTS_URL ?? '',
  };

  validateConfig(config);

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

const validateConfig = (config: Config): void => {
  if (! config.snapshotsUrl) throw new Error('SNAPSHOTS_URL is required');
};

export default loadConfig();
