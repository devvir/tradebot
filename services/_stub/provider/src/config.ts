import { logger } from '@devvir/service-kit';
import type { Config } from './types';

const loadConfig = (): Config => {
  const config: Config = {
    librarianUrl: process.env.LIBRARIAN_URL ?? '',
  };

  if (! config.librarianUrl) throw new Error('LIBRARIAN_URL is required');

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

export default loadConfig();
