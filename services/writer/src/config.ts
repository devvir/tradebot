import { logger } from '@devvir/service';
import { redactUrl, sanitizeUrl } from '@tradebot/utils';
import { Config } from './types';

export const loadConfig = (): Config => {
  const config = {
    mongodbUrl: sanitizeUrl(process.env.MONGODB_URL || ''),
    database: process.env.WRITER_DATABASE || '',
    rabbitmqUrl: sanitizeUrl(process.env.RABBITMQ_URL || ''),
    exchangeName: process.env.WRITER_EXCHANGE || '',
    queueName: process.env.WRITER_QUEUE || '',
    batchSize: parseInt(process.env.WRITER_BATCH_SIZE || '0'),
    batchTimeoutMs: parseInt(process.env.WRITER_BATCH_TIMEOUT_MS || '0'),
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
  if (! config.database) throw new Error('WRITER_DATABASE is required');
  if (! config.rabbitmqUrl) throw new Error('RABBITMQ_URL is required');
  if (! config.exchangeName) throw new Error('WRITER_EXCHANGE is required');
  if (! config.queueName) throw new Error('WRITER_QUEUE is required');
  if (config.batchSize <= 0) throw new Error('WRITER_BATCH_SIZE must be a positive number');
  if (config.batchTimeoutMs <= 0) throw new Error('WRITER_BATCH_TIMEOUT_MS must be a positive number');
};
