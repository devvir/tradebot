import { logger } from '@devvir/service-kit';
import type { Config } from './types';

const loadConfig = (): Config => {
  const watchQueues = process.env.CLERK_WATCH_QUEUES ?? '';

  const config: Config = {
    vaultUrl:       process.env.VAULT_URL ?? '',
    maxReady:       parseInt(process.env.CLERK_BACKPRESSURE_LIMIT ?? '100000'),
    watchQueues:    watchQueues.split(',').map(s => s.trim()).filter(Boolean),
  };

  if (! config.vaultUrl)
    throw new Error('VAULT_URL is required');

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

export default loadConfig();
