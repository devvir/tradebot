import { setMaxListeners } from 'node:events';
import WebSocket from 'ws';
import { logger, type Service } from '@devvir/service-kit';
import { venueFor } from './venues';
import { connect } from './websocket';
import type { MessageHandler, PoolEntry } from './types';

const PAUSE_WARN_AFTER_MS = 30_000;

const pool = new Map<string, PoolEntry>();

/** Aborted on shutdown: from then on no socket of the pool is made or replaced. */
const stopping = new AbortController();
setMaxListeners(0, stopping.signal);

/** Services whose shutdown already closes the pool. */
const watched = new WeakSet<Service>();

/** Backpressure state: while paused, every socket of the pool stops reading, one that opens later included. */
let paused        = false;
let pausedAt      = 0;
let pauseWarning: NodeJS.Timeout | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * One socket per (venue, endpoint, socketKey). The socketKey lets a venue
 * split an endpoint across several sockets, where what tells them apart is a
 * property of the subscription and not of the frame.
 */
export const poolKey = (venue: string, endpointName: string, socketKey = ''): string =>
  `${venue}:${endpointName}:${socketKey}`;

// ── Connection management ─────────────────────────────────────────────────────

export interface GetOrConnectOptions {
  socketKey?: string;

  /**
   * Called with the entry and the socket each time one of the entry's sockets
   * opens — the first one and every reconnected replacement. Fixed by the call
   * that creates the entry.
   */
  onOpen?: (entry: PoolEntry, ws: WebSocket) => void;
}

/**
 * The pool entry for (venue, endpoint, socketKey), connecting it if it does
 * not exist yet. The entry is in the pool by the time this returns, so a second
 * call for the same key — even one made before the socket opens — shares it.
 *
 * Every socket the entry opens, the first one and every replacement, is paused
 * on 'open' if backpressure is on at that moment, before `onOpen` runs: its
 * subscribe frames still go out, and their answers are read on resume.
 *
 * The first call for a service ties the pool to that service's shutdown (see
 * `closeAll`).
 */
export const getOrConnect = (
  venue:        string,
  endpointName: string,
  service:      Service,
  onMessage:    MessageHandler,
  options:      GetOrConnectOptions = {},
): PoolEntry => {
  const { socketKey = '', onOpen } = options;
  const key      = poolKey(venue, endpointName, socketKey);
  const existing = pool.get(key);

  if (existing) return existing;

  const v        = venueFor(venue);
  const endpoint = v.endpoints().find(e => e.name === endpointName);

  if (! endpoint)
    throw new Error(`Venue '${venue}' has no endpoint '${endpointName}'`);

  watchShutdown(service);

  const entry: PoolEntry = { ws: null, channels: new Set() };

  pool.set(key, entry);

  const watchOpen = (ws: WebSocket): void => {
    ws.once('open', () => {
      if (paused) ws.pause();

      onOpen?.(entry, ws);
    });
  };

  entry.ws = connect(endpoint, venue, service, onMessage, {
    socketKey,
    signal: stopping.signal,
    onReconnect: (newWs) => {
      if (pool.get(key) !== entry) return;

      entry.ws = newWs;
      watchOpen(newWs);
    },
  });

  if (entry.ws) watchOpen(entry.ws);

  return entry;
};

// ── Shutdown ──────────────────────────────────────────────────────────────────

const watchShutdown = (service: Service): void => {
  if (watched.has(service)) return;

  watched.add(service);
  service.on('shutdown', () => closeAll(service));
};

/**
 * Stop collecting, synchronously: mark the service as shutting down, cancel
 * every pending reconnect, and pause and terminate every entry's current
 * socket, so none of them reads from the network again or is replaced. It
 * waits for nothing; frames a socket had already read may still reach the
 * relay.
 */
const closeAll = (service: Service): void => {
  service.setState('isShuttingDown', true);
  stopping.abort();

  for (const { ws } of pool.values()) {
    ws?.pause();
    ws?.terminate();
  }
};

// ── Backpressure ──────────────────────────────────────────────────────────────

/**
 * Stop reading on every socket of the pool, and on every socket that opens
 * until `resumeAll`. A paused socket reads no control frames either, so it
 * answers no ping from its venue; a pause lasting past 30 s is logged as a
 * warning.
 */
export const pauseAll = (): void => {
  if (! paused) {
    paused       = true;
    pausedAt     = Date.now();
    pauseWarning = setTimeout(() => {
      logger.warn(`WebSocket reads paused by publish backpressure for over ${PAUSE_WARN_AFTER_MS}ms; venues may drop the unresponsive sockets`);
    }, PAUSE_WARN_AFTER_MS);
    pauseWarning.unref?.();
  }

  for (const { ws } of pool.values()) {
    if (ws?.readyState === WebSocket.OPEN) ws.pause();
  }
};

/** Resume reading on every paused socket of the pool. */
export const resumeAll = (): void => {
  if (paused) {
    const pausedForMs = Date.now() - pausedAt;

    if (pauseWarning) { clearTimeout(pauseWarning); pauseWarning = null; }
    if (pausedForMs >= PAUSE_WARN_AFTER_MS) logger.info(`WebSocket reads resumed after ${pausedForMs}ms`);

    paused = false;
  }

  for (const { ws } of pool.values()) {
    if (ws?.isPaused) ws.resume();
  }
};
