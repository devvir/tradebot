import { logger } from '@devvir/service-kit';
import { redactCredentials } from '@tradebot/utils';
import { Config } from './types';

const loadConfig = (): Config => {
  const config: Config = {
    bouncerUrl:   process.env['BOUNCER_URL']   ?? '',
    bouncerToken: process.env['BOUNCER_TOKEN'] ?? '',
  };

  validateConfig(config);

  logger.info({
    ...config,
    bouncerToken: redactCredentials(config.bouncerToken),
  }, 'Configuration loaded and validated!');

  return config;
};

const validateConfig = (config: Config): void => {
  if (! config.bouncerUrl)   throw new Error('BOUNCER_URL is required');
  if (! config.bouncerToken) throw new Error('BOUNCER_TOKEN is required');
};

export default loadConfig();
