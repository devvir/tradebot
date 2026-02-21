import { logger } from '@devvir/service';
import { redactUrl, sanitizeUrl } from '@tradebot/utils';
import { Config } from './types';

export const codecStrategies = (process.env.CODEC_STRATEGY || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(s => !! s);

export const codecStrategy = {
  trim: () => codecStrategies.includes('trim'),
  binary: () => codecStrategies.includes('binary'),
  passthru: () => codecStrategies.length === 0,
} as const;

export const loadConfig = (): Config => {
  const config = {
    rabbitmqUrl: sanitizeUrl(process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672'),
  };

  validateConfig(config);

  logger.info({
    ...config,
    rabbitmqUrl: redactUrl(config.rabbitmqUrl),
  }, 'Configuration loaded and validated!');

  return config;
};

const validateConfig = (config: Config): void => {
  if (! config.rabbitmqUrl) throw new Error('RABBITMQ_URL is required');
};
