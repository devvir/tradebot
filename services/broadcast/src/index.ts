import { logger } from '@devvir/service';
import { loadConfig } from './config';
import { connectToQueue } from './rabbitmq';
import { createConnections } from './websocket';
import { createMessageHandler } from './messages';
import service from './service';
import type { FeedState } from './types';

const config = loadConfig();

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

service.run(async () => {
  logger.info('Starting BitMEX Broadcast Service...');

  const broker = state.broker = await connectToQueue(config);

  broker.getExchange()!.setBackpressureHandler((paused) => {
    if (paused) { state.realtime?.pause(); state.platform?.pause(); }
    else        { state.realtime?.resume(); state.platform?.resume(); }
  });

  const onMessage = createMessageHandler(state, config);

  // ── WebSocket connections ─────────────────────────────────────────────────
  const { connectRealtime, connectPlatform } = createConnections(state, config, onMessage);
  if (config.realtimeChannels.length > 0) connectRealtime();
  if (config.platformChannels.length > 0) connectPlatform();

  logger.info('Service started successfully');

  return { state, broker };
});
