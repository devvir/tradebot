import logger from './logger';

export interface Config {
  rabbitmqUrl: string;
  mongodbUrl: string;
  mongodbDb: string;
  batchSize: number;
  batchTimeoutMs: number;
  healthPort: number;
}

const buildRabbitMQUrl = (): string => {
  // If RABBITMQ_URL is provided, use it directly
  if (process.env.RABBITMQ_URL) {
    return process.env.RABBITMQ_URL;
  }

  // Otherwise, build from separate credentials with URL encoding
  const user = encodeURIComponent(process.env.RABBITMQ_USER || 'guest');
  const pass = encodeURIComponent(process.env.RABBITMQ_PASS || 'guest');
  const host = process.env.RABBITMQ_HOST || 'rabbitmq';
  const port = process.env.RABBITMQ_PORT || '5672';

  return `amqp://${user}:${pass}@${host}:${port}`;
};

const buildMongoDBUrl = (): string => {
  // If MONGODB_URL is provided, use it directly
  if (process.env.MONGODB_URL) {
    return process.env.MONGODB_URL;
  }

  // Otherwise, build from separate credentials with URL encoding
  const user = encodeURIComponent(process.env.MONGODB_USER || 'root');
  const pass = encodeURIComponent(process.env.MONGODB_PASS || 'password');
  const host = process.env.MONGODB_HOST || 'mongodb';
  const port = process.env.MONGODB_PORT || '27017';
  const authSource = process.env.MONGODB_AUTH_SOURCE || 'admin';

  return `mongodb://${user}:${pass}@${host}:${port}/?authSource=${authSource}`;
};

export const loadConfig = (): Config => {
  return {
    rabbitmqUrl: buildRabbitMQUrl(),
    mongodbUrl: buildMongoDBUrl(),
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
