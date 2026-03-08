import { logger } from '@devvir/service';
import { defineLifecycle } from '@devvir/service';
import type { MongoClient } from 'mongodb';
import type { Broker } from '@devvir/rabbitmq';

const MESSAGE_LOG_INTERVAL = 20_000;
const HEALTH_INACTIVITY_MS = 60_000;

interface WriterResources {
  mongo: MongoClient;
  broker: Broker;
  onShutdown: () => Promise<void>;
}

let mongo: MongoClient | null = null;
let broker: Broker | null = null;
let onShutdown: (() => Promise<void>) | null = null;

let messagesProcessed = 0;
let lastProcessedTime = Date.now();

/**
 * Called by persistence layer on each stored message.
 * Tracks activity for health checks and monitoring.
 */
const onMessage = (): void => {
  messagesProcessed++;
  lastProcessedTime = Date.now();

  if (messagesProcessed % MESSAGE_LOG_INTERVAL === 0) {
    logger.info(messagesProcessed < 1_000_000
      ? `Processed ${(messagesProcessed / 1_000).toFixed(0)}K messages`
      : `Processed ${(messagesProcessed / 1_000_000).toFixed(2)}M messages`);
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
      onShutdown = resources.onShutdown;
    },

    onPing: async () => ({
      messagesProcessed,
      lastProcessedTime: Date.now() - lastProcessedTime,
    }),

    isHealthy: () => {
      const mongoConnected = mongo !== null;
      const mqConnected = broker?.getState() === 'connected';
      const recentActivity = Date.now() - lastProcessedTime < HEALTH_INACTIVITY_MS;
      return mongoConnected && mqConnected && recentActivity;
    },

    onShutdown: async () => {
      if (onShutdown) await onShutdown();
      if (broker) await broker.disconnect();
      if (mongo) await mongo.close();
    },
  });

  lifecycle.init().catch((error) => {
    logger.error({ err: error }, 'Failed to start Writer service');
    process.exit(1);
  });
};

export default { run, onMessage };
