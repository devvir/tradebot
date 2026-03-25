import { logger } from '@devvir/service-kit';
import { redactUrl, sanitizeUrl } from '@tradebot/utils';
import type { Config } from './types';

const loadConfig = (): Config => {
  const config: Config = {
    rabbitmqUrl: sanitizeUrl(process.env.QUEUE_URL || ''),
    prefetch: parseInt(process.env.CODEC_PREFETCH || '0'),
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
  if (config.prefetch < 0) throw new Error('CODEC_PREFETCH cannot be negative');
};

export default loadConfig();
