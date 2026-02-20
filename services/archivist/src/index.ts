import logger from '@tradebot/logger';
import { Config, loadConfig, validateConfig } from './config';
import { connectToDatabase } from './persistence';
import { connectToQueue } from './rabbitmq';
import { startHealthCheck } from './health';
import { startConsuming } from './persistence';
import type { ArchivistState, HealthState } from './types';

let state: ArchivistState = {
  mongoConnection: null,
  broker: null,
  isShuttingDown: false,
  messagesProcessed: 0,
  lastProcessedTime: Date.now(),
};

let config: Config;

const getHealthState = (): HealthState => {
  return {
    mongoConnected: state.mongoConnection !== null,
    mqConnected: state.broker?.getState() === 'connected',
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

  if (state.broker) {
    await state.broker.disconnect();
  }

  if (state.mongoConnection?.client) {
    await state.mongoConnection.client.close();
  }

  process.exit(0);
};

const connectMongoWithRetry = async (maxRetries = 10, delayMs = 5000): Promise<void> => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      state.mongoConnection = await connectToDatabase(config.mongodbUrl);
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

const main = async (): Promise<void> => {
  try {
    logger.info('Starting Archivist Service...');

    config = loadConfig();
    validateConfig(config);

    // Connect to MongoDB first - must succeed before consuming messages
    await connectMongoWithRetry();

    // Connect to RabbitMQ
    state.broker = await connectToQueue(config.rabbitmqUrl);

    logger.info('Successfully connected to RabbitMQ');

    const channel = state.broker.getChannel();
    if (! channel) {
      throw new Error('Failed to get channel from broker');
    }

    await startConsuming(
      channel,
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
