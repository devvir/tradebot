import { logger } from '@devvir/service-kit';
import { Config } from "./types";
import { redactCredentials } from '@tradebot/utils';

const DATA_PATH = '/data/bouncer/accounts.json';
const HTTP_PORT = 3010;

function loadConfig(): Config {
  const config: Config = {
    token: process.env.BOUNCER_TOKEN || '',
    dataPath: DATA_PATH,
    httpPort: HTTP_PORT,
  };

  validateConfig(config);

  logger.info({
    ...config,
    token: redactCredentials(config.token),
  }, 'Configuration loaded and validated!');

  return config;
};

const validateConfig = (config: Config): void => {
  if (! config.token) throw new Error('BOUNCER_TOKEN is required');
};

export default loadConfig();
