import logger from '@tradebot/logger';
import { loadConfig } from './config';
import { connectToQueue } from './rabbitmq';
import { startHealthCheck } from './health';
import { startConsuming } from './rabbitmq';
import type { CodecState } from './types';

const config = loadConfig();

let state: CodecState = {
  rabbitmqBroker: null,
  isShuttingDown: false,
  messagesProcessed: 0,

  lastProcessedTime: Date.now(),
};

const onProcessMsg = (): void => {
  state.messagesProcessed++;
  state.lastProcessedTime = Date.now();

  if (state.messagesProcessed % 1000 === 0) {
    logger.info(state.messagesProcessed, 'Batch processed');
  }
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

    state.rabbitmqBroker = await connectToQueue(config.rabbitmqUrl);
    logger.info('Successfully connected to RabbitMQ');

    await startConsuming(state.rabbitmqBroker, onProcessMsg);

    startHealthCheck(state);

    logger.info('Codec service initialized and consuming messages');
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMsg }, 'Failed to start service');
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
