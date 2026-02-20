import logger from '@tradebot/logger';

export interface Config {
  rabbitmqUrl: string;
  mongodbUrl: string;
  batchSize: number;
  batchTimeoutMs: number;
  healthPort: number;
}

export const loadConfig = (): Config => ({
  rabbitmqUrl: sanitizeUrl(process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672'),
  mongodbUrl: sanitizeUrl(process.env.MONGODB_URL || 'mongodb://root:root@mongodb:27017/tradebot?authSource=admin'),
  batchSize: parseInt(process.env.ARCHIVIST_BATCH_SIZE || '100', 10),
  batchTimeoutMs: parseInt(process.env.ARCHIVIST_BATCH_TIMEOUT_MS || '5000', 10),
  healthPort: 3000,
});

export const validateConfig = (config: Config): void => {
  if (! config.rabbitmqUrl) {
    throw new Error('RABBITMQ_URL is required');
  }

  if (! config.mongodbUrl) {
    throw new Error('MONGODB_URL is required');
  }

  if (config.batchSize <= 0) {
    throw new Error('ARCHIVIST_BATCH_SIZE must be greater than 0');
  }

  if (config.batchTimeoutMs <= 0) {
    throw new Error('ARCHIVIST_BATCH_TIMEOUT_MS must be greater than 0');
  }

  logger.info({ config }, 'Configuration validated');
};

/**
 * Properly encode special characters in MongoDB/AMQP connection URLs.
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