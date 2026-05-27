import { logger } from '@devvir/service-kit';
import type { Config } from './types';

const loadConfig = (): Config => {
  const config: Config = {
    database:         process.env.DB_DATABASE ?? '',
    /** When true, `E11000` duplicate-key responses are reported as success.
     *  Farmer relies on this for idempotent re-runs; other use cases can flip it off. */
    ignoreDuplicates: (process.env.LIBRARIAN_IGNORE_DUPLICATES ?? 'true').toLowerCase() === 'true',
  };

  if (! config.database)
    throw new Error('DB_DATABASE is required');

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

export default loadConfig();
