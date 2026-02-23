import { logger } from '@devvir/service';
import { redactUrl } from '@tradebot/utils';
import { Config } from './types';

export const loadConfig = (): Config => {
  const mongodbUrl = process.env.MONGODB_URL;
  const rabbitmqUrl = process.env.RABBITMQ_URL;

  const config = {
    mongodbUrl: mongodbUrl || '',
    rabbitmqUrl: rabbitmqUrl || '',
    exchangeName: process.env.ARCHIVIST_EXCHANGE || '',
    queueName: process.env.ARCHIVIST_QUEUE || '',
    batchSize: parseInt(process.env.ARCHIVIST_BATCH_SIZE || '0', 10),
    batchTimeoutMs: parseInt(process.env.ARCHIVIST_BATCH_TIMEOUT_MS || '0', 10),
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
  if (! config.rabbitmqUrl) throw new Error('RABBITMQ_URL is required');
  if (! config.mongodbUrl) throw new Error('MONGODB_URL is required');
  if (! config.exchangeName) throw new Error('ARCHIVIST_EXCHANGE is required');
  if (! config.queueName) throw new Error('ARCHIVIST_QUEUE is required');
  if (config.batchSize <= 0) throw new Error('ARCHIVIST_BATCH_SIZE must be a positive number');
  if (config.batchTimeoutMs <= 0) throw new Error('ARCHIVIST_BATCH_TIMEOUT_MS must be a positive number');
};
