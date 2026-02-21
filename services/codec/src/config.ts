import logger from '@tradebot/logger';
import { Config } from './types';

export const loadConfig = (): Config => {
  const config = {
    rabbitmqUrl: sanitizeUrl(process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672'),
  };

  validateConfig(config);

  const rabbitmqUrlRedacted = config.rabbitmqUrl.replace(/\/\/(.+:.+)@rabbitmq/, '//*****@rabbitmq');
  const safeConfig = { ...config, rabbitmqUrl: rabbitmqUrlRedacted };
  logger.info({ config: safeConfig }, 'Configuration loaded and validated!');

  return config;
};

export const codecStrategies = (process.env.CODEC_STRATEGY || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(s => !! s);

export const codecStrategy = {
  trim: () => codecStrategies.includes('trim'),
  binary: () => codecStrategies.includes('binary'),
  passthru: () => codecStrategies.length === 0,
} as const;

const validateConfig = (config: Config): void => {
  if (! config.rabbitmqUrl) {
    throw new Error('RABBITMQ_URL is required');
  }
};

/**
 * Properly encode special characters in AMQP connection URLs.
 * Credentials must be URL-encoded to handle special characters like @, :, /, etc.
 */
const sanitizeUrl = (url: string): string => {
  const urlObj = new URL(url);

  try {
    if (urlObj.username) urlObj.username = encodeURIComponent(decodeURIComponent(urlObj.username));
    if (urlObj.password) urlObj.password = encodeURIComponent(decodeURIComponent(urlObj.password));
  } catch (error) {
    logger.warn({ error, url }, 'Failed to parse URL, using as-is');
    return url;
  }

  return urlObj.toString();
};
