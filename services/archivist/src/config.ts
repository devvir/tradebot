import { logger } from '@devvir/service';
import { redactUrl, sanitizeUrl } from '@tradebot/utils';

export interface Config {
  rabbitmqUrl: string;
  mongodbUrl: string;
  batchSize: number;
  batchTimeoutMs: number;
  healthPort: number;
}

export const loadConfig = (): Config => {
  const config = {
    rabbitmqUrl: sanitizeUrl(process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672'),
    mongodbUrl: sanitizeUrl(process.env.MONGODB_URL || 'mongodb://root:root@mongodb:27017/tradebot?authSource=admin'),
    batchSize: parseInt(process.env.ARCHIVIST_BATCH_SIZE || '1000', 10),
    batchTimeoutMs: parseInt(process.env.ARCHIVIST_BATCH_TIMEOUT_MS || '5000', 10),
    healthPort: 3000,
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
  if (config.batchSize <= 0) throw new Error('ARCHIVIST_BATCH_SIZE must be greater than 0');
  if (config.batchTimeoutMs <= 0) throw new Error('ARCHIVIST_BATCH_TIMEOUT_MS must be greater than 0');
};