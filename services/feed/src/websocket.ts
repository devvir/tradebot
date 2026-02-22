import WebSocket from 'ws';
import { logger } from '@devvir/service';
import type { Config, EndpointConnections, EndpointDefinition, FeedState, MessageHandler } from './types';

/**
 * Creates the two BitMEX WebSocket connections (realtime + platform).
 *
 * Returns `{ connectRealtime, connectPlatform }`, to establish (or re-establish) each connection.
 */
export const createConnections = (state: FeedState, config: Config, onMessage: MessageHandler): EndpointConnections => {
  const scheduleReconnect = (connect: () => void): void => {
    setTimeout(connect, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, config.connection.maxReconnectDelayMs);
  };

  const makeConnect = (ep: EndpointDefinition): (() => void) => {
    const connect = (): void => {
      if (state.isShuttingDown) return;

      logger.info({ endpoint: ep }, 'Connecting to Websocket endpoint');
      const ws = state[ep.name] = new WebSocket(ep.url);

      ws.on('open', () => {
        logger.info(`Connected to ${ep.name}`);
        state.reconnectDelay = config.connection.reconnectDelayMs;
        state.lastMessageTime = Date.now();
        subscribeToTopics(ws, ep.channels);
        state.pingInterval = startHeartbeat(ws);
      });

      ws.on('ping', () => ws.pong());
      ws.on('pong', () => logger.debug(`Pong from ${ep.name}`));
      ws.on('message', (msg: Buffer) => onMessage(msg));
      ws.on('error', (err: Error) => logger.error({ error: err.message }, `${ep.name} WebSocket error`));
      ws.on('close', (code: number, reason: Buffer) => {
        logger.warn({ code, reason: reason.toString() }, `${ep.name} closed, reconnecting...`);
        if (state.pingInterval) { clearInterval(state.pingInterval); state.pingInterval = null; }
        if (! state.isShuttingDown) scheduleReconnect(connect);
      });
    };

    return connect;
  };

  const endpoints: EndpointDefinition[] = [
    { name: 'realtime', url: config.realtimeWsUrl, channels: config.realtimeChannels },
    { name: 'platform', url: config.platformWsUrl, channels: config.platformChannels },
  ];

  const [ connectRealtime, connectPlatform ] = endpoints.map(ep => makeConnect(ep));

  return { connectRealtime, connectPlatform };
};

const startHeartbeat = (ws: WebSocket): NodeJS.Timeout => setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) ws.ping();
}, 30000);

/**
 * Subscribe to a list of BitMEX channels in a single message.
 * Channels are plain names (e.g., 'trade'), no symbol suffix.
 */
const subscribeToTopics = (ws: WebSocket, channels: readonly string[]): void => {
  if (channels.length === 0) return;
  logger.info({ channels }, 'Subscribing to channels');
  ws.send(JSON.stringify({ op: 'subscribe', args: channels }));
};
