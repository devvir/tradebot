import { logger } from '@devvir/service-kit';
import { Config } from './types';

const loadConfig = (): Config => {
  const config = {
    wsPort: parseInt(process.env.WS_PORT ?? '0'),
    snapshotsUrl: process.env.SNAPSHOTS_URL ?? '',
  };

  validateConfig(config);

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

const validateConfig = (config: Config): void => {
  if (! config.wsPort) throw new Error('WS_PORT is required');
  if (! config.snapshotsUrl) throw new Error('SNAPSHOTS_URL is required');
};

export default loadConfig();
