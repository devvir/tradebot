import WebSocket from 'ws';
import { logger, type Service } from '@devvir/service-kit';
import type { ConnectOptions, EndpointDefinition, MessageHandler } from './types';

const RECONNECT_DELAY_MS     = 200;
const MAX_RECONNECT_DELAY_MS = 15_000;
const HEARTBEAT_INTERVAL_MS  = 30_000;

/** Node socket error codes that are routine and expected — logged concisely, without a stack trace. */
const KNOWN_NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN',
  'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE',
]);

interface ReconnectState {
  delayMs: number;
  timer:   NodeJS.Timeout | null;
}

/**
 * Connect to a BitMEX WebSocket endpoint.
 *
 * Handles lifecycle (heartbeat, pong, reconnect with backoff). The caller
 * receives the WebSocket and is responsible for tracking it. On reconnect, the
 * `onReconnect` callback provides the replacement instance.
 *
 * Reconnection is single-flight: a failed connection emits both `error` and
 * `close`, and a sustained outage emits those pairs repeatedly — but only one
 * reconnect attempt is ever in flight, so attempts never pile up.
 */
export const connect = (
  endpoint:  EndpointDefinition,
  service:   Service,
  onMessage: MessageHandler,
  options:   ConnectOptions = {},
): WebSocket => {
  const { credentials, accountId, pool, onReconnect } = options;

  // The no-pool socket (e.g. instrument, whose pool filter is ignored) stays just
  // `guest`/account; each per-pool socket appends its pool so the four guest
  // connections are distinguishable in the logs.
  const label = [accountId ?? 'guest', pool].filter(Boolean).join('/');

  const reconnect: ReconnectState = { delayMs: RECONNECT_DELAY_MS, timer: null };

  const doConnect = (): WebSocket => {
    if (service.state('isShuttingDown')) return null!;

    const url = credentials
      ? `${endpoint.url}?api-key=${credentials.apiKey}&api-expires=${credentials.expires}&api-signature=${credentials.signature}`
      : endpoint.url;

    logger.info({ endpointName: endpoint.name, account: label }, 'Connecting to Websocket endpoint');

    const ws = new WebSocket(url).setMaxListeners(0);
    let pingInterval: NodeJS.Timeout | null = null;
    let errorLogged = false;

    ws.on('open', () => {
      logger.info(`Connected to ${endpoint.name} (${label})`);

      service.setState('lastMessageTime', Date.now());
      pingInterval = startHeartbeat(ws);

      reconnect.delayMs = RECONNECT_DELAY_MS;
    });

    ws.on('ping', () => ws.pong());
    ws.on('pong', () => logger.debug(`Pong from ${endpoint.name} (${label})`));
    ws.on('message', (msg: Buffer) => onMessage(msg, accountId, pool));

    ws.on('error', (err: Error) => {
      errorLogged = true;

      const known = describeError(err);

      if (known)
        logger.warn(`${endpoint.name} WebSocket (${label}): ${known}`);
      else
        logger.error({ err }, `${endpoint.name} WebSocket error (${label})`);

      // A 429 means we are already reconnecting too fast — skip the ramp and
      // back off at the cap immediately.
      if (isRateLimited(err)) reconnect.delayMs = MAX_RECONNECT_DELAY_MS;

      scheduleReconnect();
    });

    ws.on('close', (code: number, reason: Buffer) => {
      if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }

      // A close following an error is expected — the error line already covered it.
      if (! errorLogged)
        logger.warn({ code, reason: reason.toString() }, `${endpoint.name} closed (${label})`);

      scheduleReconnect();
    });

    return ws;
  };

  /**
   * Schedule a single reconnect attempt. Single-flight: if an attempt is
   * already pending this is a no-op, so the `error` + `close` pair from one
   * failure (and any repeats) collapse into exactly one attempt.
   */
  const scheduleReconnect = (): void => {
    if (reconnect.timer) return;
    if (service.state('isShuttingDown')) return;

    const delay = reconnect.delayMs;

    logger.info(`Reconnecting to ${endpoint.name} (${label}) in ${delay}ms`);

    reconnect.timer = setTimeout(() => {
      reconnect.timer = null;

      const next = doConnect();
      if (next) onReconnect?.(next);
    }, delay);

    reconnect.delayMs = Math.min(reconnect.delayMs * 2, MAX_RECONNECT_DELAY_MS);
  };

  return doConnect();
};

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Describe a known/expected connection failure as a short phrase, or return
 * `null` for an unexpected error (which the caller logs in full, with stack).
 */
const describeError = (err: Error): string | null => {
  if (isRateLimited(err)) return 'rate limited (HTTP 429) — backing off';

  const code = (err as NodeJS.ErrnoException).code;
  if (code && KNOWN_NETWORK_CODES.has(code)) return `network unavailable (${code})`;

  const httpStatus = err.message.match(/Unexpected server response: (\d+)/);
  if (httpStatus) return `server returned HTTP ${httpStatus[1]}`;

  if (/socket hang up/i.test(err.message)) return 'socket hang up';

  return null;
};

const isRateLimited = (err: Error): boolean =>
  /Unexpected server response: 429\b/.test(err.message);

const startHeartbeat = (ws: WebSocket): NodeJS.Timeout =>
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, HEARTBEAT_INTERVAL_MS);
