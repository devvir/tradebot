import { logger } from '@devvir/service-kit';
import { Config } from './types';

const loadConfig = (): Config => {
  const config = {
    wsCommandsUrl: process.env.WS_COMMANDS_URL ?? '',
  };

  validateConfig(config);

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

const validateConfig = (config: Config): void => {
  if (! config.wsCommandsUrl) throw new Error('WS_COMMANDS_URL is required');
};

export default loadConfig();
