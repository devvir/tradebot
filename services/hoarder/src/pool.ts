import WebSocket from 'ws';
import { type Service } from '@devvir/service-kit';
import { venueFor } from './venues';
import { connect } from './websocket';
import type { MessageHandler, PoolEntry } from './types';

const pool = new Map<string, PoolEntry>();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * One socket per (venue, endpoint, socketKey). The socketKey lets a venue
 * split an endpoint across several sockets — BitMEX uses it for liquidity
 * pools, since the pool is a property of the subscription, not the frame.
 */
export const poolKey = (venue: string, endpointName: string, socketKey = ''): string =>
  `${venue}:${endpointName}:${socketKey}`;

// ── Pool access ───────────────────────────────────────────────────────────────

export const get    = (key: string) => pool.get(key);
export const set    = (key: string, entry: PoolEntry) => pool.set(key, entry);
export const remove = (key: string) => pool.delete(key);

// ── Connection management ─────────────────────────────────────────────────────

export const getOrConnect = async (
  venue:        string,
  endpointName: string,
  service:      Service,
  onMessage:    MessageHandler,
  socketKey  =  '',
): Promise<PoolEntry> => {
  const key      = poolKey(venue, endpointName, socketKey);
  const existing = pool.get(key);

  if (existing) return existing;

  const v        = venueFor(venue);
  const endpoint = v.endpoints().find(e => e.name === endpointName);

  if (! endpoint)
    throw new Error(`Venue '${venue}' has no endpoint '${endpointName}'`);

  const entry: PoolEntry = { ws: null!, channels: new Set() };

  pool.set(key, entry);

  const ws = connect(endpoint, venue, service, onMessage, {
    socketKey,
    onReconnect: (newWs) => {
      const e = pool.get(key);
      if (! e) return;

      e.ws = newWs;

      // Resubscribe tracked channels after the new connection opens
      if (e.channels.size > 0) {
        newWs.once('open', () => {
          newWs.send(v.subscribeFrame([...e.channels]));
        });
      }
    },
  });

  service.on('shutdown', () => ws.close());

  entry.ws = ws;

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
