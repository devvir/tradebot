import { logger } from '@devvir/service';
import { redactUrl, sanitizeUrl } from '@tradebot/utils';
import { Config } from './types';

export const loadConfig = (): Config => {
  const config = {
    mongodbUrl: sanitizeUrl(process.env.MONGODB_URL || ''),
    rabbitmqUrl: sanitizeUrl(process.env.RABBITMQ_URL || ''),
    prefetch: parseInt(process.env.WRITER_PREFETCH || '500'),
    flushIntervalMs: parseInt(process.env.WRITER_FLUSH_INTERVAL_MS || '50'),
  };

  validateConfig(config);

  logger.info({
    ...config,
    rabbitmqUrl: redactUrl(config.rabbitmqUrl),
    mongodbUrl: redactUrl(config.mongodbUrl),
  }, 'Configuration loaded and validated!');

  return config;
};

export const validateConfig = (config: Config): void => {
  if (! config.mongodbUrl) throw new Error('MONGODB_URL is required');
  if (! config.rabbitmqUrl) throw new Error('RABBITMQ_URL is required');
  if (config.prefetch < 50) throw new Error('WRITER_PREFETCH must be greater than 50');
  if (config.flushIntervalMs < 20) throw new Error('WRITER_FLUSH_INTERVAL_MS must be greater than 20');
};
