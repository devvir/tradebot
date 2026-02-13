import logger from './logger';

export interface Config {
  rabbitmqUrl: string;
  mongodbUrl: string;
  mongodbDb: string;
  batchSize: number;
  batchTimeoutMs: number;
  healthPort: number;
}

export const loadConfig = (): Config => {
  return {
    rabbitmqUrl: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
    mongodbUrl:
      process.env.MONGODB_URL ||
      'mongodb://root:root@localhost:27017/?authSource=admin',
    mongodbDb: process.env.MONGODB_DB || 'tradebot',
    batchSize: parseInt(process.env.ARCHIVIST_BATCH_SIZE || '100', 10),
    batchTimeoutMs: parseInt(process.env.ARCHIVIST_BATCH_TIMEOUT_MS || '5000', 10),
    healthPort: 3000,
  };
};

export const validateConfig = (config: Config): void => {
  if (!config.rabbitmqUrl) {
    throw new Error('RABBITMQ_URL is required');
  }
  if (!config.mongodbUrl) {
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
