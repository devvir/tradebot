import { logger } from '@devvir/service-kit';
import { Config } from './types';

const loadConfig = (): Config => {
  const config: Config = {
    vaultUrl:  process.env.VAULT_URL ?? '',
    startDate: parseStartDate(process.env.COURIER_START_DATE),
  };

  if (! config.vaultUrl) throw new Error('VAULT_URL is required');

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

const parseStartDate = (raw: string | undefined): string | null => {
  if (! raw) return null;

  const normalised = raw.replace(/[-/]/g, '');

  if (! /^\d{8}$/.test(normalised))
    throw new Error(`COURIER_START_DATE must be yyyy-mm-dd or yyyymmdd, got: ${raw}`);

  return normalised;
};

export default loadConfig();
