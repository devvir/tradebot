import { logger, defineLifecycle } from '@devvir/service';
import type { Broker } from '@devvir/rabbitmq';
import type { CodecState } from './types';

/**
 * Resources returned by the service's init flow.
 * Lifecycle uses these for health checks and shutdown.
 */
interface CodecResources {
  state: CodecState;
  broker: Broker;
}

// Resources captured from the init flow
let state: CodecState | null = null;
let broker: Broker | null = null;

// Activity tracking
let messagesProcessed = 0;
let lastProcessedTime = Date.now();

const MESSAGE_LOG_INTERVAL = 20_000;

/**
 * Called by message handler on each processed message.
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
const run = (flow: () => Promise<CodecResources>): void => {
  const lifecycle = defineLifecycle({
    dependencies: ['rabbitmq'],

    onInit: async () => {
      const resources = await flow();
      state = resources.state;
      broker = resources.broker;
    },

    onPing: async () => ({
      messagesProcessed,
      lastProcessedTime: Date.now() - lastProcessedTime,
      brokerConnected: broker?.getState?.() === 'connected',
    }),

    isHealthy: () => {
      if (! state || ! broker) return false;

      const brokerConnected = broker.getState?.() === 'connected';
      const recentActivity = Date.now() - state.lastProcessedTime < 60000;

      return brokerConnected && recentActivity;
    },

    onShutdown: async () => {
      state!.isShuttingDown = true;
      if (broker) await broker.disconnect();
    },
  });

  lifecycle.init().catch((error) => {
    logger.error({ err: error }, 'Failed to start Codec service');
    process.exit(1);
  });
};

export default { run, onMessage };
