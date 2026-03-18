import { logger } from '@devvir/service-kit';
import type { Config } from './types.js';

const BITMEX_REST_URLS = {
  live:    'https://www.bitmex.com/api/v1',
  testnet: 'https://testnet.bitmex.com/api/v1',
} as const;

const usesTestnet = () =>
  [undefined, '', '1', 'on', 'true'].includes(
    process.env.BITMEX_TESTNET?.toLowerCase()
  );

export const loadConfig = (): Config => {
  const config: Config = {
    bitmexRestUrl: usesTestnet() ? BITMEX_REST_URLS.testnet : BITMEX_REST_URLS.live,
    database:      process.env.HISTORY_DATABASE ?? '',
  };

  validateConfig(config);

  logger.info({ ...config }, 'Configuration loaded and validated!');

  return config;
};

const validateConfig = (config: Config): void => {
  if (! config.database) throw new Error('HISTORY_DATABASE is required');
};

export default loadConfig();
