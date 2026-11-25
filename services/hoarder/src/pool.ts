import WebSocket from 'ws';
import { type Service } from '@devvir/service-kit';
import { venueFor } from './venues';
import { connect } from './websocket';
import type { MessageHandler, PoolEntry } from './types';

const pool = new Map<string, PoolEntry>();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * One socket per (venue, endpoint, socketKey). The socketKey lets a venue
 * split an endpoint across several sockets, where what tells them apart is a
 * property of the subscription and not of the frame.
 */
export const poolKey = (venue: string, endpointName: string, socketKey = ''): string =>
  `${venue}:${endpointName}:${socketKey}`;

// ── Pool access ───────────────────────────────────────────────────────────────

export const get    = (key: string) => pool.get(key);
export const set    = (key: string, entry: PoolEntry) => pool.set(key, entry);
export const remove = (key: string) => pool.delete(key);

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

  const entry: PoolEntry = { ws: null!, channels: new Set() };

  pool.set(key, entry);

  const watchOpen = (ws: WebSocket): void => {
    ws.once('open', () => onOpen?.(entry, ws));
  };

  const ws = connect(endpoint, venue, service, onMessage, {
    socketKey,
    onReconnect: (newWs) => {
      if (pool.get(key) !== entry) return;

      entry.ws = newWs;
      watchOpen(newWs);
    },
  });

  service.on('shutdown', () => ws.close());

  entry.ws = ws;

  if (ws) watchOpen(ws);

  return entry;
};

// ── Backpressure ──────────────────────────────────────────────────────────────

export const pauseAll = (): void => {
  for (const { ws } of pool.values()) {
    if (ws?.readyState === WebSocket.OPEN) ws.pause();
  }
};

export const resumeAll = (): void => {
  for (const { ws } of pool.values()) {
    if (ws?.readyState === WebSocket.OPEN) ws.resume();
  }
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_reset = (): void => pool.clear();
