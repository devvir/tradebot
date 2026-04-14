import { logger } from '@devvir/service-kit';

export interface Config {
  wsUrl:          string;
  restUrl:        string;
  accountId:      string;
  strategy:       string;
  symbol:         string;
  tickIntervalMs: number;
  [key: string]:  unknown;
}

const loadConfig = (): Config => {
  const config: Config = {
    wsUrl:          process.env.TRADER_WS_URL          ?? '',
    restUrl:        process.env.TRADER_REST_URL         ?? '',
    accountId:      process.env.TRADER_ACCOUNT_ID       ?? '',
    strategy:       process.env.TRADER_STRATEGY         ?? 'range',
    symbol:         process.env.TRADER_SYMBOL           ?? 'XBTUSD',
    tickIntervalMs: parseInt(process.env.TRADER_TICK_INTERVAL_MS ?? '30000', 10),
  };

  if (! config.wsUrl)     throw new Error('TRADER_WS_URL is required');
  if (! config.restUrl)   throw new Error('TRADER_REST_URL is required');
  if (! config.accountId) throw new Error('TRADER_ACCOUNT_ID is required');

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

export default loadConfig();
