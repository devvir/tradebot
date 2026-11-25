import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import { logger, type Service } from '@devvir/service-kit';
import type { ConnectOptions, EndpointDefinition, MessageHandler } from './types';

const RECONNECT_DELAY_MS     = 200;
const MAX_RECONNECT_DELAY_MS = 15_000;
const RECONNECT_JITTER       = 0.2;
const STABLE_AFTER_MS        = 30_000;
const HANDSHAKE_TIMEOUT_MS   = 10_000;
const HEARTBEAT_INTERVAL_MS  = 30_000;

/** Node socket error codes that are routine and expected — logged concisely, without a stack trace. */
const KNOWN_NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN',
  'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE',
]);

/** A handshake answered with a rate-limit status; the status is the first group. */
const RATE_LIMITED = /Unexpected server response: (418|429)\b/;

/**
 * The back-off is held as the next delay rather than as a count of failures, as
 * `@tradebot/utils`' `backoffDelay` counts them, because two events set it
 * outright: a stable socket puts it back to the start, and a rate-limited
 * handshake puts it at the cap.
 */
interface ReconnectState {
  delayMs: number;
  timer:   NodeJS.Timeout | null;
}

/**
 * Connect to a venue's WebSocket endpoint.
 *
 * Venue-agnostic: lifecycle only (handshake timeout, heartbeat, reconnect with
 * backoff). The caller receives the WebSocket and is responsible for tracking
 * it. On reconnect, the `onReconnect` callback provides the replacement
 * instance. Returns null, and connects nothing, when already stopping.
 *
 * Liveness: a handshake that does not complete within 10 s fails the socket.
 * An open socket is pinged every 30 s, and one that has not answered the
 * previous ping (with a pong or any other frame) by the next tick is
 * terminated. A paused socket reads nothing, so it is neither pinged nor
 * judged while paused.
 *
 * Reconnection: only the `close` of the endpoint's current socket schedules a
 * replacement, once per socket. An `error` never schedules one itself; on an
 * open or closing socket it terminates the socket, so its `close` follows at
 * once instead of after the closing handshake. A replacement is made only after
 * its predecessor is closed, so the endpoint has at most one socket.
 *
 * Stopping: once the service is shutting down or `signal` is aborted, no
 * socket is made or replaced; aborting cancels a pending reconnect. A socket
 * closing then is expected, so its close and its error are logged only at
 * debug.
 *
 * Identity: every socket gets a fresh connection id (a UUID), passed with each
 * of its frames to `onMessage` and named in the log lines of its connect, open
 * and close. A reconnect therefore shows as a change of connection id, and the
 * log says when each socket opened and closed.
 *
 * Inbound frames go to `onMessage`; a rejection from it is logged and the
 * socket carries on.
 *
 * Backoff: the delay starts at 200 ms and doubles on every reconnect, up to
 * 15 s, with ±20% jitter (never above 15 s). It returns to 200 ms only once a
 * socket has stayed open for 30 s, so a venue that accepts connections and
 * then drops them is retried ever more slowly. A handshake refused with HTTP
 * 418 or 429 sets the delay to 15 s at once.
 */
export const connect = (
  endpoint:  EndpointDefinition,
  venue:     string,
  service:   Service,
  onMessage: MessageHandler,
  options:   ConnectOptions = {},
): WebSocket | null => {
  const { socketKey, onReconnect, signal } = options;

  // Sockets sharing an endpoint are told apart in the logs by their socketKey
  // (a stream shard); the plain one is just the venue name.
  const label = [venue, socketKey].filter(Boolean).join('/');

  const reconnect: ReconnectState = { delayMs: RECONNECT_DELAY_MS, timer: null };

  let current: WebSocket | null = null;

  const stopping = (): boolean => Boolean(service.state('isShuttingDown')) || signal?.aborted === true;

  signal?.addEventListener('abort', () => {
    if (reconnect.timer) { clearTimeout(reconnect.timer); reconnect.timer = null; }
  }, { once: true });

  const doConnect = (): WebSocket | null => {
    if (stopping()) return null;

    if (current && current.readyState !== WebSocket.CLOSED) current.terminate();

    const connectionId = randomUUID();

    logger.info({ endpointName: endpoint.name, socket: label, connectionId }, 'Connecting to Websocket endpoint');

    const ws = new WebSocket(endpoint.url, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS }).setMaxListeners(0);

    current = ws;

    let heartbeat:    NodeJS.Timeout | null = null;
    let stable:       NodeJS.Timeout | null = null;
    let awaitingPong = false;
    let errorLogged  = false;
    let replaced     = false;

    const alive = (): void => { awaitingPong = false; };

    ws.on('open', () => {
      logger.info({ connectionId }, `Connected to ${endpoint.name} (${label})`);

      stable    = setTimeout(() => { reconnect.delayMs = RECONNECT_DELAY_MS; }, STABLE_AFTER_MS);
      heartbeat = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;

        // A paused socket reads no frames, its pong included: judging it would
        // kill a healthy socket, so its deadline starts over once it resumes.
        if (ws.isPaused) return alive();

        if (awaitingPong) {
          logger.warn(`${endpoint.name} (${label}) did not answer a ping within ${HEARTBEAT_INTERVAL_MS}ms — terminating`);
          return ws.terminate();
        }

        awaitingPong = true;
        ws.ping();
      }, HEARTBEAT_INTERVAL_MS);
    });

    // ws answers a venue's ping itself (autoPong); any inbound frame proves the
    // connection is alive.
    ws.on('ping', alive);
    ws.on('pong', alive);
    ws.on('message', (msg: Buffer) => {
      alive();
      onMessage(msg, venue, connectionId).catch(err => logger.error({ err, venue }, 'Relay failed'));
    });

    ws.on('error', (err: Error) => {
      errorLogged = true;

      const known = describeError(err);

      if (stopping())
        logger.debug({ err }, `${endpoint.name} WebSocket error while stopping (${label})`);
      else if (known)
        logger.warn(`${endpoint.name} WebSocket (${label}): ${known}`);
      else
        logger.error({ err }, `${endpoint.name} WebSocket error (${label})`);

      // A rate-limit status means we are already reconnecting too fast — skip
      // the ramp and back off at the cap immediately.
      if (RATE_LIMITED.test(err.message)) reconnect.delayMs = MAX_RECONNECT_DELAY_MS;

      // An error on an open socket (an invalid or oversized frame) starts a
      // closing handshake that may take up to 30 s to end; end it now instead.
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) ws.terminate();
    });

    ws.on('close', (code: number, reason: Buffer) => {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      if (stable)    { clearTimeout(stable); stable = null; }

      if (ws !== current || replaced) return;

      replaced = true;

      if (stopping())
        return logger.debug({ connectionId, code }, `${endpoint.name} closed while stopping (${label})`);

      // A close following an error is expected: the error line already gave the cause.
      if (errorLogged)
        logger.info({ connectionId, code }, `${endpoint.name} closed after an error (${label})`);
      else
        logger.warn({ connectionId, code, reason: reason.toString() }, `${endpoint.name} closed (${label})`);

      scheduleReconnect();
    });

    return ws;
  };

  /** Schedule the replacement of the current socket, after the backoff delay. */
  const scheduleReconnect = (): void => {
    if (reconnect.timer) return;
    if (stopping()) return;

    const delay = withJitter(reconnect.delayMs);

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
  const limited = err.message.match(RATE_LIMITED);
  if (limited) return `rate limited (HTTP ${limited[1]}) — backing off`;

  const code = (err as NodeJS.ErrnoException).code;
  if (code && KNOWN_NETWORK_CODES.has(code)) return `network unavailable (${code})`;

  const httpStatus = err.message.match(/Unexpected server response: (\d+)/);
  if (httpStatus) return `server returned HTTP ${httpStatus[1]}`;

  if (/socket hang up/i.test(err.message)) return 'socket hang up';

  return null;
};

/** Spread reconnects of many sockets apart: ±20%, never above the cap. */
const withJitter = (delayMs: number): number =>
  Math.min(Math.round(delayMs * (1 - RECONNECT_JITTER + 2 * RECONNECT_JITTER * Math.random())), MAX_RECONNECT_DELAY_MS);
