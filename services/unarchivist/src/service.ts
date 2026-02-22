import { logger, defineLifecycle } from '@devvir/service';
import type { Broker } from '@devvir/rabbitmq';
import type { UnarchivistState } from './types';

/**
 * Resources returned by the service's init flow.
 * Lifecycle uses these for health checks and shutdown.
 */
interface UnarchivistResources {
  state: UnarchivistState;
  broker: Broker;
}

// Resources captured from the init flow
let state: UnarchivistState | null = null;
let broker: Broker | null = null;

// Activity tracking
let messagesPublished = 0;
let lastPublishedTime = Date.now();

/**
 * Called by polling loop on each published message.
 * Tracks activity for health checks and monitoring.
 */
const onMessage = (): void => {
  messagesPublished++;
  lastPublishedTime = Date.now();

  if (messagesPublished % 10000 === 0) {
    logger.info(`Published ${Math.floor(messagesPublished / 1000)}k messages`);
  }
};

/**
 * Run the service with full lifecycle management.
 * The flow callback contains the business logic (the recipe).
 * Its returned resources are used for health checks and cleanup.
 */
const run = (flow: () => Promise<UnarchivistResources>): void => {
  const lifecycle = defineLifecycle({
    dependencies: ['mongodb', 'rabbitmq'],

    onInit: async () => {
      const resources = await flow();
      state = resources.state;
      broker = resources.broker;
    },

    onPing: async () => ({
      messagesPublished,
      lastPublishedTime: Date.now() - lastPublishedTime,
      mongoConnected: state?.mongoConnection !== null,
      brokerConnected: broker?.getState?.() === 'connected',
    }),

    isHealthy: () => {
      if (! state || ! broker) return false;

      const mongoConnected = state.mongoConnection !== null;
      const brokerConnected = broker.getState?.() === 'connected';
      const recentActivity = Date.now() - state.lastPublishedTime < 300000; // 5 min threshold for polling service

      return mongoConnected && brokerConnected && recentActivity;
    },

    onShutdown: async () => {
      state!.isShuttingDown = true;

      if (broker) await broker.disconnect();
      if (state?.mongoConnection?.client) await state.mongoConnection.client.close();
    },
  });

  lifecycle.init().catch((error) => {
    logger.error({ error }, 'Failed to start Unarchivist service');
    process.exit(1);
  });
};

export default { run, onMessage };
