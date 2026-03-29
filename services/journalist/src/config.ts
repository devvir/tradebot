import { logger } from '@devvir/service-kit';
import { sanitizeUrl, redactUrl } from '@tradebot/utils';
import type { Config } from './types';

const loadConfig = (): Config => {
  const config: Config = {
    rabbitmqUrl: sanitizeUrl(process.env.QUEUE_URL || ''),
    vaultUrl:    process.env.VAULT_URL ?? '',
  };

  validateConfig(config);

  logger.info({
    ...config,
    rabbitmqUrl: redactUrl(config.rabbitmqUrl),
  }, 'Configuration loaded and validated!');

  return config;
};

const validateConfig = (config: Config): void => {
  if (! config.rabbitmqUrl) throw new Error('QUEUE_URL is required');
  if (! config.vaultUrl)    throw new Error('VAULT_URL is required');
};

export default loadConfig();
