import logger from './logger';
import { Config, loadConfig, validateConfig } from './config';
import { connectToQueue } from './rabbitmq';
import { startHealthCheck } from './health';
import { startConsuming } from './rabbitmq';
import type { CodecState, HealthState } from './types';

let state: CodecState = {
  rabbitmqBroker: null,
  isShuttingDown: false,
  messagesProcessed: 0,
  messagesPublished: 0,
  lastProcessedTime: Date.now(),
};

let config: Config;

const getHealthState = (): HealthState => {
  return {
    mqConnected: state.rabbitmqBroker !== null && state.rabbitmqBroker.getState() === 'connected',
    messagesProcessed: state.messagesProcessed,
    messagesPublished: state.messagesPublished,
    lastProcessedTime: state.lastProcessedTime,
  };
};

const onProcessMsg = (): void => {
  state.messagesProcessed++;
  state.lastProcessedTime = Date.now();

  if (state.messagesProcessed % 1000 === 0) {
    logger.info(
      { processed: state.messagesProcessed, published: state.messagesPublished },
      'Batch processed'
    );
  }
};

const onPublishMsg = (): void => {
  state.messagesPublished++;
};

const shutdown = async (): Promise<void> => {
  logger.info('Shutting down gracefully...');
  state.isShuttingDown = true;

  if (state.rabbitmqBroker) {
    await state.rabbitmqBroker.disconnect();
  }

  process.exit(0);
};

const main = async (): Promise<void> => {
  try {
    logger.info('Starting Codec Service...');

    config = loadConfig();
    validateConfig(config);

    state.rabbitmqBroker = await connectToQueue(config.rabbitmqUrl);

    logger.info('Successfully connected to RabbitMQ');

    await startConsuming(state.rabbitmqBroker, onProcessMsg, onPublishMsg);

    startHealthCheck(config.healthPort, getHealthState);

    logger.info('Codec service initialized and consuming messages');
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
