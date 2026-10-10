import { logger } from '@devvir/service-kit';
import type { Config } from './types';

// Tardis began collecting BitMEX data on this date. The first first-of-month
// date that actually falls within the Tardis archive is 2019-04-01, but the
// archive genesis is the more accurate default — targetDates advances to the
// first eligible first-of-month on or after this date.
const DEFAULT_START_DATE = '20190330';

const loadConfig = (): Config => {
  const config: Config = {
    vaultUrl:  process.env.VAULT_URL  ?? '',
    startDate: parseStartDate(process.env.TARDY_START_DATE),
    suffix:    process.env.TARDY_SUFFIX ?? '',
  };

  if (! config.vaultUrl) throw new Error('VAULT_URL is required');

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

const parseStartDate = (raw: string | undefined): string => {
  if (! raw) return DEFAULT_START_DATE;

  const normalised = raw.replace(/[-/]/g, '');

  if (! /^\d{8}$/.test(normalised))
    throw new Error(`TARDY_START_DATE must be yyyy-mm-dd or yyyymmdd, got: ${raw}`);

  return normalised;
};

export default loadConfig();
