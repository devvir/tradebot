import { logger } from '@devvir/service-kit';
import type { Config } from './types';

const loadConfig = (): Config => {
  const config: Config = {
    database:           process.env.DB_DATABASE ?? '',
    prefetch:           parseInt(process.env.REGISTRAR_PREFETCH             ?? '500'),
    flushIntervalMs:    parseInt(process.env.REGISTRAR_FLUSH_INTERVAL_MS    ?? '50'),
    progressIntervalMs: parseInt(process.env.REGISTRAR_PROGRESS_INTERVAL_MS ?? '1000'),
  };

  if (! config.database)
    throw new Error('DB_DATABASE is required');

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

export default loadConfig();
