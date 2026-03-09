import WebSocket from 'ws';
import { logger, defineLifecycle } from '@devvir/service';
import type { Broker } from '@devvir/rabbitmq';
import type { FeedState } from './types';

/**
 * Resources returned by the service's init flow.
 * Lifecycle uses these for health checks and shutdown.
 */
interface FeedResources {
  state: FeedState;
  broker: Broker;
}

// Resources captured from the init flow
let state: FeedState | null = null;
let broker: Broker | null = null;

// Activity tracking
let messagesProcessed = 0;
let lastProcessedTime = Date.now();

const MESSAGE_LOG_INTERVAL = 20_000;

/**
 * Called by message handler on each received message.
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
const run = (flow: () => Promise<FeedResources>): void => {
  const lifecycle = defineLifecycle({
    dependencies: ['rabbitmq', 'websockets'],

    onInit: async () => {
      const resources = await flow();
      state = resources.state;
      broker = resources.broker;
    },

    onPing: async () => ({
      messagesProcessed,
      lastProcessedTime: Date.now() - lastProcessedTime,
      realtimeConnected: state?.realtime !== null && state?.realtime?.readyState === WebSocket.OPEN,
      platformConnected: state?.platform !== null && state?.platform?.readyState === WebSocket.OPEN,
    }),

    isHealthy: () => {
      if (! state || ! broker) return false;

      const anyConnected =
        (state.realtime !== null && state.realtime.readyState === WebSocket.OPEN) ||
        (state.platform !== null && state.platform.readyState === WebSocket.OPEN);

      const brokerConnected = broker.getState?.() === 'connected';
      const recentActivity = Date.now() - state.lastMessageTime < 60000;

      return anyConnected && brokerConnected && recentActivity;
    },

    onShutdown: async () => {
      if (state) state.isShuttingDown = true;

      if (state?.realtime) state.realtime.close();
      if (state?.platform) state.platform.close();
      if (state?.pingInterval) clearInterval(state.pingInterval);

      if (broker) await broker.disconnect();
    },
  });

  lifecycle.init().catch((error) => {
    logger.error({ err: error }, 'Failed to start Broadcast service');
    process.exit(1);
  });
};

export default { run, onMessage };
