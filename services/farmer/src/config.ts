import { logger } from '@devvir/service-kit';
import type { BitmexTable } from '@tradebot/types';
import type { Config } from './types';

const loadConfig = (): Config => {
  const tables = process.env.FARMER_TABLES ?? '';

  const config: Config = {
    database:           process.env.DB_DATABASE   ?? '',
    vaultUrl:           process.env.VAULT_URL     ?? '',
    librarianUrl:       process.env.LIBRARIAN_URL ?? '',
    tables:             tables.split(',').map(s => s.trim()).filter(Boolean) as BitmexTable[],
    fileConcurrency:    parseInt(process.env.FARMER_FILE_CONCURRENCY     ?? '10'),
    inflightCap:        parseInt(process.env.FARMER_INFLIGHT_CAP         ?? '20'),
    flushIntervalMs:    parseInt(process.env.FARMER_FLUSH_INTERVAL_MS    ?? '100'),
  };

  if (! config.database)
    throw new Error('DB_DATABASE is required');

  if (! config.vaultUrl)
    throw new Error('VAULT_URL is required');

  if (! config.librarianUrl)
    throw new Error('LIBRARIAN_URL is required');

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

export default loadConfig();
