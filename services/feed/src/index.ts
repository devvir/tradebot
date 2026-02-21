import 'dotenv/config';
import logger from '@tradebot/logger';
import { loadConfig } from './config';
import { connectToQueue } from './rabbitmq';
import { startHealthCheck } from './health';
import { createConnections } from './connection';
import { registerLifecycle } from './lifecycle';
import { createMessageHandler } from './messages';
import type { FeedState } from './types';

const main = async (): Promise<void> => {
  logger.info('Starting BitMEX Feed Service...');

  const config = loadConfig();

  // ── Service state ─────────────────────────────────────────────────────────
  const state: FeedState = {
    realtime: null,
    platform: null,
    broker: null,
    reconnectDelay: config.connection.reconnectDelayMs,
    isShuttingDown: false,
    lastMessageTime: Date.now(),
    apiVersion: null,
    pingInterval: null,
  };

  // ── RabbitMQ ──────────────────────────────────────────────────────────────
  state.broker = await connectToQueue(config.queue.rabbitmqUrl);

  // ── Message handler ───────────────────────────────────────────────────────
  const onMessage = createMessageHandler(state);

  // ── WebSocket connections ─────────────────────────────────────────────────
  const { connectRealtime, connectPlatform } = createConnections(state, config, onMessage);
  if (config.realtimeChannels.length > 0) connectRealtime();
  if (config.platformChannels.length > 0) connectPlatform();

  // ── Health & lifecycle ────────────────────────────────────────────────────
  const { getHealthState } = registerLifecycle(state);
  startHealthCheck(getHealthState);

  logger.info('Service started successfully');
};

main().catch((error) => {
  logger.error({ error }, 'Unhandled error in main');
  process.exit(1);
});
