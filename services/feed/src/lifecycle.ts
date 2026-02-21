import WebSocket from 'ws';
import logger from '@tradebot/logger';
import type { FeedState, HealthState } from './types';

/**
 * Registers SIGTERM/SIGINT handlers and performs a graceful shutdown when
 * either signal is received. Also returns a `getHealthState` callback suitable
 * for passing to `startHealthCheck`.
 *
 * Call once after the service has fully started.
 */
export const registerLifecycle = (state: FeedState): { getHealthState: () => HealthState } => {
  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down gracefully...');

    state.isShuttingDown = true;

    if (state.realtime) state.realtime.close();
    if (state.platform) state.platform.close();
    if (state.broker) await state.broker.disconnect();

    process.exit(0);
  };

  const onSignal = (sig: string) => () => {
    logger.info({ signal: sig }, 'Signal received');
    shutdown().catch((e) => logger.error({ error: e }, 'Error during shutdown'));
  };

  process.on('SIGTERM', onSignal('SIGTERM'));
  process.on('SIGINT', onSignal('SIGINT'));

  const getHealthState = (): HealthState => ({
    realtimeConnected: state.realtime !== null && state.realtime.readyState === WebSocket.OPEN,
    platformConnected: state.platform !== null && state.platform.readyState === WebSocket.OPEN,
    lastMessageTime: state.lastMessageTime,
  });

  return { getHealthState };
};
