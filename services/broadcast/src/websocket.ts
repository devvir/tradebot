import WebSocket from 'ws';
import { logger, type Service } from '@devvir/service-kit';
import type { Config, EndpointConnections, EndpointDefinition, MessageHandler } from './types';

const RECONNECT_DELAY_MS = 200;
const MAX_RECONNECT_DELAY_MS = 15_000;

let reconnectDelayMs = RECONNECT_DELAY_MS;

/**
 * Creates the two BitMEX WebSocket connections (realtime + platform).
 *
 * Returns `{ connectRealtime, connectPlatform }`, to establish (or re-establish) each connection.
 */
export default (service: Service, onMessage: MessageHandler): EndpointConnections => {
  const config = service.config() as Config;

  const endpoints: Record<string, EndpointDefinition> = {
    realtime: { name: 'realtime', url: config.realtimeWsUrl, channels: config.realtimeChannels },
    platform: { name: 'platform', url: config.platformWsUrl, channels: config.platformChannels },
  };

  const connect = (endpointName: keyof typeof endpoints): void => {
    if (service.state('isShuttingDown')) return;

    logger.info({ endpointName }, 'Connecting to Websocket endpoint');

    const endpoint: EndpointDefinition = endpoints[endpointName];
    const ws = service.setState(endpoint.name, new WebSocket(endpoint.url));

    ws.on('open', () => {
      logger.info(`Connected to ${endpoint.name}`);

      service.setState('lastMessageTime', Date.now());
      service.setState('pingInterval', startHeartbeat(ws));

      reconnectDelayMs = RECONNECT_DELAY_MS;

      subscribeToTopics(ws, endpoint.channels);
    });

    ws.on('ping', () => ws.pong());
    ws.on('pong', () => logger.debug(`Pong from ${endpoint.name}`));
    ws.on('message', (msg: Buffer) => onMessage(msg));

    ws.on('error', (err: Error) => {
      logger.error({ err }, `${endpoint.name} WebSocket error`);
      scheduleReconnect(() => connect(endpointName));
    });

    ws.on('close', (code: number, reason: Buffer) => {
      logger.warn({ code, reason: reason.toString() }, `${endpoint.name} closed, reconnecting...`);

      const pingInterval = service.state('pingInterval') as NodeJS.Timeout | null;
      if (pingInterval) { clearInterval(pingInterval); service.setState('pingInterval', null); }

      if (! service.state('isShuttingDown'))
        scheduleReconnect(() => connect(endpointName));
    });
  };

  return {
    connectRealtime: () => connect('realtime'),
    connectPlatform: () => connect('platform'),
  } as EndpointConnections;
};

const scheduleReconnect = (connect: () => void): void => {
  setTimeout(connect, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
};

const startHeartbeat = (ws: WebSocket): NodeJS.Timeout =>
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30000);

/**
 * Subscribe to a list of BitMEX channels in a single message.
 */
const subscribeToTopics = (ws: WebSocket, channels: readonly string[]): void => {
  if (channels.length === 0) return;

  logger.info({ channels }, 'Subscribing to channels');

  ws.send(JSON.stringify({ op: 'subscribe', args: channels }));
};
