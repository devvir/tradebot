import { logger } from '@devvir/service';
import { redactUrl, sanitizeUrl } from '@tradebot/utils';
import type { Config } from './types';

/**
 * Magic numbers for the polling algorithm.
 * Tune these to adjust behavior (e.g., if hitting timeout or missing docs).
 */
export const BUFFER_SIZE = 1000; // Sliding window of _ids to catch out-of-order writes
export const POLL_INTERVAL_MS = 3000; // Time between polls in milliseconds

export const loadConfig = (): Config => {
  const collectionsEnv = process.env.UNARCHIVIST_COLLECTIONS || '';
  const collections = collectionsEnv.split(',').map((c) => c.trim()).filter(Boolean);

  const config: Config = {
    rabbitmqUrl: sanitizeUrl(process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672'),
    mongodbUrl: sanitizeUrl(process.env.MONGODB_URL || 'mongodb://root:root@mongodb:27017/tradebot?authSource=admin'),
    batchSize: parseInt(process.env.UNARCHIVIST_BATCH_SIZE || '1000', 10),
    collections,
    healthPort: 3000,
    pollIntervalMs: parseInt(process.env.UNARCHIVIST_POLL_INTERVAL_MS || String(POLL_INTERVAL_MS), 10),
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
  if (config.batchSize <= 0) throw new Error('UNARCHIVIST_BATCH_SIZE must be greater than 0');
};
