import SK from './service';
import type { RabbitMQ } from '@devvir/service-kit';
import { createConnections } from './websocket';
import { createMessageHandler } from './messages';
import type { Config, FeedState } from './types';

SK.run(async (service) => {
  const config = service.config() as Config;

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

  const broker = state.broker = await service.providers.connect('rabbitmq') as RabbitMQ.Broker;

  broker.getExchange('broadcast')!.setBackpressureHandler((paused) => {
    if (paused) { state.realtime?.pause(); state.platform?.pause(); }
    else        { state.realtime?.resume(); state.platform?.resume(); }
  });

  const onMessage = createMessageHandler(state, config, () => service.emit('message'));

  // ── WebSocket connections ─────────────────────────────────────────────────
  const { connectRealtime, connectPlatform } = createConnections(state, config, onMessage);

  if (config.realtimeChannels.length > 0) connectRealtime();
  if (config.platformChannels.length > 0) connectPlatform();
});
