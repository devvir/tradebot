import { logger } from '@devvir/service';
import { redactUrl, sanitizeUrl } from '@tradebot/utils';
import { Config } from './types';

export const loadConfig = (): Config => {
  const config = {
    mongodbUrl: sanitizeUrl(process.env.MONGODB_URL || ''),
    rabbitmqUrl: sanitizeUrl(process.env.RABBITMQ_URL || ''),
    batchSize: parseInt(process.env.WRITER_PREFETCH || '0'),
    dbArchive: process.env.DATABASE_ARCHIVE || '',
    dbCollect: process.env.DATABASE_COLLECT || '',
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
  if (! config.rabbitmqUrl) throw new Error('RABBITMQ_URL is required');
  if (config.batchSize <= 0) throw new Error('WRITER_PREFETCH must be a positive number');
  if (! config.dbArchive) throw new Error('DATABASE_ARCHIVE is required');
  if (! config.dbCollect) throw new Error('DATABASE_COLLECT is required');
};
