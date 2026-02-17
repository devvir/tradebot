import logger from './logger';

export interface Config {
  rabbitmqUrl: string;
  healthPort: number;
}

export const loadConfig = (): Config => ({
  rabbitmqUrl: sanitizeUrl(process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672'),
  healthPort: 3000,
});

export const validateConfig = (config: Config): void => {
  if (! config.rabbitmqUrl) {
    throw new Error('RABBITMQ_URL is required');
  }

  logger.info({ config }, 'Configuration validated');
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
