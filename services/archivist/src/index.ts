import logger from './logger';
import { Config, loadConfig, validateConfig } from './config';
import { connectMongoDB } from './mongodb';
import { connectRabbitMQ } from './rabbitmq';
import { startHealthCheck } from './health';
import { startConsuming } from './persistence';
import type { ArchivistState, HealthState } from './types';

let state: ArchivistState = {
  mongoConnection: null,
  rabbitmqConnection: null,
  isShuttingDown: false,
  messagesProcessed: 0,
  lastProcessedTime: Date.now(),
};

let config: Config;

const getHealthState = (): HealthState => {
  return {
    mongoConnected: state.mongoConnection !== null,
    mqConnected: state.rabbitmqConnection !== null,
    messagesProcessed: state.messagesProcessed,
    lastProcessedTime: state.lastProcessedTime,
  };
};

const onStoreMsg = (): void => {
  state.messagesProcessed++;
  state.lastProcessedTime = Date.now();

  if (state.messagesProcessed % 1000 === 0) {
    logger.info({ processed: state.messagesProcessed }, 'Batch inserted');
  }
};

const shutdown = async (): Promise<void> => {
  logger.info('Shutting down gracefully...');
  state.isShuttingDown = true;

  if (state.rabbitmqConnection?.channel) {
    await state.rabbitmqConnection.channel.close();
  }

  if (state.rabbitmqConnection?.connection) {
    await (state.rabbitmqConnection.connection as any).close();
  }

  if (state.mongoConnection?.client) {
    await state.mongoConnection.client.close();
  }

  process.exit(0);
};

const connectMongoWithRetry = async (maxRetries = 10, delayMs = 5000): Promise<void> => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      state.mongoConnection = await connectMongoDB(config.mongodbUrl, config.mongodbDb);
      logger.info('Successfully connected to MongoDB');
      return;
    } catch (error) {
      logger.warn({ error, attempt: i + 1, maxRetries }, 'Failed to connect to MongoDB, retrying...');
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw new Error(`Failed to connect to MongoDB after ${maxRetries} attempts`);
};

const connectRabbitMQWithRetry = async (maxRetries = 10, delayMs = 3000): Promise<void> => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      state.rabbitmqConnection = await connectRabbitMQ(config.rabbitmqUrl);
      logger.info('Successfully connected to RabbitMQ');
      return;
    } catch (error) {
      logger.warn({ error, attempt: i + 1, maxRetries }, 'Failed to connect to RabbitMQ, retrying...');
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw new Error(`Failed to connect to RabbitMQ after ${maxRetries} attempts`);
};

const main = async (): Promise<void> => {
  try {
    logger.info('Starting Archivist Service...');

    config = loadConfig();
    validateConfig(config);

    // Connect to MongoDB first - must succeed before consuming messages
    await connectMongoWithRetry();

    // Connect to RabbitMQ
    await connectRabbitMQWithRetry();

    await startConsuming(
      state.rabbitmqConnection!.channel,
      state.mongoConnection!.db,
      config.batchSize,
      onStoreMsg
    );

    startHealthCheck(config.healthPort, getHealthState);

    logger.info('Archivist service initialized and consuming messages');
  } catch (error) {
    logger.error({ error }, 'Failed to start service');
    process.exit(1);
  }
};

process.on('SIGTERM', () => {
  shutdown().catch((error) => logger.error({ error }, 'Error during shutdown'));
});

process.on('SIGINT', () => {
  shutdown().catch((error) => logger.error({ error }, 'Error during shutdown'));
});

main().catch((error) => {
  logger.error({ error }, 'Unhandled error in main');
  process.exit(1);
});
