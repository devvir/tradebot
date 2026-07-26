/**
 * Configuration loader.
 *
 * URLs are interchangeable: TRADER_WS_URL and TRADER_REST_URL can point at our
 * own ws/rest services (the default deployment) or at BitMEX directly. The
 * trader signs every request with TRADER_API_KEY/TRADER_API_SECRET (BitMEX-
 * compatible HMAC) and our proxy detects pre-signed requests and forwards them
 * verbatim, so the same code path works either way.
 */

import { logger } from '@devvir/service-kit';
import type { Config } from './types';

const DEFAULT_TICK_INTERVAL_MS = 30_000;

const loadConfig = (): Config => {
  const config: Config = {
    wsUrl:          process.env.TRADER_WS_URL          ?? '',
    restUrl:        process.env.TRADER_REST_URL        ?? '',
    apiKey:         process.env.TRADER_API_KEY         ?? '',
    apiSecret:      process.env.TRADER_API_SECRET      ?? '',
    strategy:       process.env.TRADER_STRATEGY        ?? 'range',
    symbol:         process.env.TRADER_SYMBOL          ?? 'XBTUSD',
    tickIntervalMs: parseInt(process.env.TRADER_TICK_INTERVAL_MS ?? String(DEFAULT_TICK_INTERVAL_MS), 10),
  };

  validate(config);

  // Don't log the secret — log everything else
  const safe = { ...config, apiSecret: '***' };

  logger.info(safe, 'Configuration loaded and validated!');

  return config;
};

const validate = (config: Config): void => {
  if (! config.wsUrl)     throw new Error('TRADER_WS_URL is required');
  if (! config.restUrl)   throw new Error('TRADER_REST_URL is required');
  if (! config.apiKey)    throw new Error('TRADER_API_KEY is required');
  if (! config.apiSecret) throw new Error('TRADER_API_SECRET is required');
};

export default loadConfig();

// ---- Test exports ------------------------------------------------------

export const _test_loadConfig = loadConfig;
export const _test_validate   = validate;
