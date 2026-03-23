// Pending Review
import { logger } from '@devvir/service-kit';
import type { Config } from './types';
import { redactCredentials } from '@tradebot/utils';

const HTTP_PORT = 3001;

const loadConfig = (): Config => {
  const config: Config = {
    bouncerUrl:   process.env['BOUNCER_URL']    ?? '',
    bouncerToken: process.env['BOUNCER_TOKEN']  ?? '',
    httpPort:     HTTP_PORT,
    restUrl:      process.env['EXECUTOR_REST_URL'] ?? '',
  };

  validateConfig({
    ...config,
    bouncerToken: redactCredentials(config.bouncerToken),
  });

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

const validateConfig = (config: Config): void => {
  if (! config.bouncerUrl)   throw new Error('BOUNCER_URL is required');
  if (! config.bouncerToken) throw new Error('BOUNCER_TOKEN is required');
  if (! config.restUrl)      throw new Error('EXECUTOR_REST_URL is required');
};

export default loadConfig();
