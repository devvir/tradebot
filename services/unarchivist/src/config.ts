import { logger } from '@devvir/service';
import { redactUrl, sanitizeUrl } from '@tradebot/utils';
import type { Config } from './types';

/**
 * Sliding window of _ids to catch out-of-order writes.
 * This is a tuning parameter for the polling algorithm.
 */
export const BUFFER_SIZE = 1000;

export const loadConfig = (): Config => {
  const collectionsEnv = process.env.UNARCHIVIST_COLLECTIONS || '';

  const config: Config = {
    mongodbUrl: sanitizeUrl(process.env.MONGODB_URL || ''),
    rabbitmqUrl: sanitizeUrl(process.env.RABBITMQ_URL || ''),
    exchangeName: process.env.UNARCHIVIST_EXCHANGE || '',
    queueName: process.env.UNARCHIVIST_QUEUE || '',
    batchSize: parseInt(process.env.UNARCHIVIST_BATCH_SIZE || '0', 10),
    pollIntervalMs: parseInt(process.env.UNARCHIVIST_POLL_INTERVAL_MS || '0', 10),
    collections: collectionsEnv.split(',').map((c) => c.trim()).filter(Boolean),
  };

  validateConfig(config);

  logger.info({
    ...config,
    rabbitmqUrl: redactUrl(config.rabbitmqUrl),
    mongodbUrl: redactUrl(config.mongodbUrl),
  }, 'Configuration loaded and validated!');

  return config;
};

const validateConfig = (config: Config): void => {
  if (! config.rabbitmqUrl) throw new Error('RABBITMQ_URL is required');
  if (! config.mongodbUrl) throw new Error('MONGODB_URL is required');
  if (! config.exchangeName) throw new Error('UNARCHIVIST_EXCHANGE is required');
  if (! config.queueName) throw new Error('UNARCHIVIST_QUEUE is required');
  if (config.batchSize <= 0) throw new Error('UNARCHIVIST_BATCH_SIZE must be a positive number');
  if (config.pollIntervalMs <= 0) throw new Error('UNARCHIVIST_POLL_INTERVAL_MS must be a positive number');
};
