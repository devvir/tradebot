import { logger } from '@devvir/service';
import { defineLifecycle } from '@devvir/service';
import type { Broker } from '@devvir/rabbitmq';
import type { MongoDBConnection } from './types';

/**
 * Resources returned by the service's init flow.
 * Lifecycle uses these for health checks and shutdown.
 */
interface WriterResources {
  mongo: MongoDBConnection;
  broker: Broker;
}

// Resources captured from the init flow
let mongo: MongoDBConnection | null = null;
let broker: Broker | null = null;

// Activity tracking
let messagesProcessed = 0;
let lastProcessedTime = Date.now();

/**
 * Called by persistence layer on each stored message.
 * Tracks activity for health checks and monitoring.
 */
const onMessage = (): void => {
  messagesProcessed++;
  lastProcessedTime = Date.now();

  if (messagesProcessed % 10000 === 0) {
    logger.info(`Processed ${ Math.floor(messagesProcessed / 1000) }k messages`);
  }
};

/**
 * Run the service with full lifecycle management.
 * The flow callback contains the business logic (the recipe).
 * Its returned resources are used for health checks and cleanup.
 */
const run = (flow: () => Promise<WriterResources>): void => {
  const lifecycle = defineLifecycle({
    dependencies: ['mongodb', 'rabbitmq'],

    onInit: async () => {
      const resources = await flow();
      mongo = resources.mongo;
      broker = resources.broker;
    },

    onPing: async () => ({
      messagesProcessed,
      lastProcessedTime: Date.now() - lastProcessedTime,
    }),

    isHealthy: () => {
      const mongoConnected = mongo !== null;
      const mqConnected = broker?.getState() === 'connected';
      const recentActivity = Date.now() - lastProcessedTime < 60000;
      return mongoConnected && mqConnected && recentActivity;
    },

    onShutdown: async () => {
      if (broker) await broker.disconnect();
      if (mongo?.client) await mongo.client.close();
    },
  });

  lifecycle.init().catch((error) => {
    logger.error({ err: error }, 'Failed to start Writer service');
    process.exit(1);
  });
};

export default { run, onMessage };
