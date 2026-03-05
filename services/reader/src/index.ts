import { logger } from '@devvir/service';
import { loadConfig } from './config';
import { connectToDatabase } from './persistence';
import { connectToQueue } from './rabbitmq';
import { loadPollingState, startPeriodicStateSave } from './state';
import { runPollingLoop } from './poller';
import { createPublisher } from './publisher';
import service from './service';
import type { ReaderState } from './types';

const config = loadConfig();

const state: ReaderState = {
  mongoConnection: null,
  broker: null,
  isShuttingDown: false,
  messagesPublished: 0,
  lastPublishedTime: Date.now(),
};

service.run(async () => {
  [ state.mongoConnection, state.broker ] = await Promise.all([
    connectToDatabase(config),
    connectToQueue(config),
  ]);

  const db = state.mongoConnection.db;

  await loadPollingState(db);
  await startPeriodicStateSave(db);

  const publish = createPublisher(state.broker!, config);

  runPollingLoop(db, config, async (collection, doc) => {
    await publish(collection, doc);
    service.onMessage();
  });

  logger.info('Reader service started');

  return { state, broker: state.broker! };
});
