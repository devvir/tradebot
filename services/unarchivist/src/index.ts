import { logger } from '@devvir/service';
import { loadConfig } from './config';
import { connectToDatabase } from './persistence';
import { connectToQueue, publishDocument } from './rabbitmq';
import { loadPollingState, startPeriodicStateSave } from './state';
import { runPollingLoop } from './poller';
import service from './service';
import type { UnarchivistState } from './types';

const config = loadConfig();

const state: UnarchivistState = {
  mongoConnection: null,
  broker: null,
  isShuttingDown: false,
  messagesPublished: 0,
  lastPublishedTime: Date.now(),
};

service.run(async () => {
  logger.info('Starting Unarchivist Service (polling-based)...');

  // ── Connect to infrastructure ─────────────────────────────────────────────
  [state.mongoConnection, state.broker] = await Promise.all([
    connectToDatabase(config.mongodbUrl),
    connectToQueue(config),
  ]);

  const db = state.mongoConnection.db;
  await loadPollingState(db);

  await startPeriodicStateSave(db);

  // ── Start polling loop (discovers collections dynamically on each iteration) ─
  runPollingLoop(db, config, async (collectionName, doc) => {
    await publishDocument(state.broker!, collectionName, doc, config);
    service.onMessage();
  });

  logger.info('Unarchivist service started');

  return { state, broker: state.broker! };
});
