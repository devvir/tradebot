import { logger } from '@devvir/service';
import { loadConfig } from './config';
import { connectToQueue, startConsuming } from './rabbitmq';
import service from './service';
import type { CodecState } from './types';

const config = loadConfig();

const state: CodecState = {
  rabbitmqBroker: null,
  isShuttingDown: false,
  messagesProcessed: 0,
  lastProcessedTime: Date.now(),
};

service.run(async () => {
  logger.info('Starting Codec Service...');

  const broker = state.rabbitmqBroker = await connectToQueue(config);

  await startConsuming(broker, config, service.onMessage);

  return { state, broker };
});
