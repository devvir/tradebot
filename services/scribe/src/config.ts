import { logger } from '@devvir/service-kit';
import type { Config } from './types';

const BITMEX_REST_URL = 'https://www.bitmex.com/api/v1';

const loadConfig = (): Config => {
  const config: Config = {
    bitmexRestUrl: BITMEX_REST_URL,
    vaultUrl:      process.env.VAULT_URL ?? '',
    startDate:     parseStartDate(process.env.SCRIBE_START_DATE),
    indexTickOnly: parseBool(process.env.SCRIBE_INDEX_TICK_ONLY),
    tables:        parseList(process.env.SCRIBE_TABLES),
    inFlight:      parsePositiveInt(process.env.SCRIBE_IN_FLIGHT, 20),
    rateWaterline: parsePositiveInt(process.env.SCRIBE_RATE_WATERLINE, 100),
  };

  validateConfig(config);

  logger.info(config, 'Configuration loaded');

  return config;
};

const validateConfig = (config: Config): void => {
  if (! config.vaultUrl) throw new Error('VAULT_URL is required');
};

const parseBool = (raw: string | undefined): boolean =>
  ['1', 'on', 'true'].includes(raw?.trim().toLowerCase() ?? '');

const parseList = (raw: string | undefined): string[] =>
  raw?.split(',').map(s => s.trim()).filter(Boolean) ?? [];

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  if (! raw?.trim()) return fallback;

  const n = parseInt(raw, 10);

  if (! Number.isInteger(n) || n <= 0)
    throw new Error(`Expected a positive integer, got: ${raw}`);

  return n;
};

const parseStartDate = (raw: string | undefined): string | null => {
  if (! raw) return null;

  const normalised = raw.replace(/[-/]/g, '');

  if (! /^\d{8}$/.test(normalised))
    throw new Error(`SCRIBE_START_DATE must be yyyy-mm-dd or yyyymmdd, got: ${raw}`);

  return normalised;
};

export default loadConfig();
