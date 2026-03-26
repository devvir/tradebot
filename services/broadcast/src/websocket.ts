import WebSocket from 'ws';
import { logger, type Service } from '@devvir/service-kit';
import type { ConnectOptions, EndpointDefinition, MessageHandler } from './types';

const RECONNECT_DELAY_MS = 200;
const MAX_RECONNECT_DELAY_MS = 15_000;

let reconnectDelayMs = RECONNECT_DELAY_MS;

/**
 * Connect to a BitMEX WebSocket endpoint.
 *
 * Handles lifecycle (heartbeat, pong, reconnect with backoff). The caller
 * receives the WebSocket and is responsible for tracking it. On reconnect, the
 * `onReconnect` callback provides the replacement instance.
 */
export const connect = (
  endpoint:  EndpointDefinition,
  service:   Service,
  onMessage: MessageHandler,
  options:   ConnectOptions = {},
): WebSocket => {
  const { credentials, accountId, onReconnect } = options;
  const label = accountId ?? 'guest';

  const doConnect = (): WebSocket => {
    if (service.state('isShuttingDown')) return null!;

    const url = credentials
      ? `${endpoint.url}?api-key=${credentials.apiKey}&api-expires=${credentials.expires}&api-signature=${credentials.signature}`
      : endpoint.url;

    logger.info({ endpointName: endpoint.name, account: label }, 'Connecting to Websocket endpoint');

    const ws = new WebSocket(url);
    let pingInterval: NodeJS.Timeout | null = null;

    ws.on('open', () => {
      logger.info(`Connected to ${endpoint.name} (${label})`);

      service.setState('lastMessageTime', Date.now());
      pingInterval = startHeartbeat(ws);

      reconnectDelayMs = RECONNECT_DELAY_MS;
    });

    ws.on('ping', () => ws.pong());
    ws.on('pong', () => logger.debug(`Pong from ${endpoint.name} (${label})`));
    ws.on('message', (msg: Buffer) => onMessage(msg, accountId));

    ws.on('error', (err: Error) => {
      logger.error({ err }, `${endpoint.name} WebSocket error (${label})`);
      scheduleReconnect(() => {
        const next = doConnect();
        if (next) onReconnect?.(next);
      });
    });

    ws.on('close', (code: number, reason: Buffer) => {
      logger.warn({ code, reason: reason.toString() }, `${endpoint.name} closed (${label})`);

      if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }

      if (! service.state('isShuttingDown'))
        scheduleReconnect(() => {
          const next = doConnect();
          if (next) onReconnect?.(next);
        });
    });

    return ws;
  };

  return doConnect();
};

// ── Private helpers ───────────────────────────────────────────────────────────

const scheduleReconnect = (reconnect: () => void): void => {
  setTimeout(reconnect, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
};

const startHeartbeat = (ws: WebSocket): NodeJS.Timeout =>
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30000);
