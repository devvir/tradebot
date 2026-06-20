import WebSocket from 'ws';
import { type Service } from '@devvir/service-kit';
import type { Config, Credentials, EndpointDefinition, MessageHandler, PoolEntry } from './types';
import { PLATFORM_CHANNELS } from '@tradebot/utils';
import { connect } from './websocket';

const pool = new Map<string, PoolEntry>();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Private Channel privateNotifications is not supported (it's in the platform
 * endpoint, unlike all other private channels, and is currently not in use).
 */
export const endpointForChannel = (channel: string): 'platform' | 'realtime' =>
  (PLATFORM_CHANNELS as readonly string[]).includes(channel) ? 'platform' : 'realtime';

export const poolKey = (endpointName: string, accountId?: string, pool?: string): string =>
  `${accountId ?? ''}:${endpointName}:${pool ?? ''}`;

export const makeEndpoint = (config: Config, name: 'realtime' | 'platform'): EndpointDefinition => ({
  name,
  url: name === 'realtime' ? config.realtimeWsUrl : config.platformWsUrl,
});

// ── Pool access ───────────────────────────────────────────────────────────────

export const get    = (key: string) => pool.get(key);
export const set    = (key: string, entry: PoolEntry) => pool.set(key, entry);
export const remove = (key: string) => pool.delete(key);

// ── Connection management ─────────────────────────────────────────────────────

export const getOrConnect = async (
  endpointName: 'realtime' | 'platform',
  service:      Service,
  onMessage:    MessageHandler,
  accountId?:   string,
  poolFilter?:  string,
): Promise<PoolEntry> => {
  const key      = poolKey(endpointName, accountId, poolFilter);
  const existing = pool.get(key);

  if (existing) return existing;

  const config      = service.config() as Config;
  const credentials = accountId ? await fetchCredentials(config, accountId) : undefined;
  const endpoint    = makeEndpoint(config, endpointName);
  const entry: PoolEntry = { ws: null!, channels: new Set() };

  pool.set(key, entry);

  const ws = connect(endpoint, service, onMessage, {
    credentials,
    accountId,
    pool: poolFilter,
    onReconnect: (newWs) => {
      const e = pool.get(key);
      if (! e) return;

      e.ws = newWs;

      // Resubscribe tracked channels after the new connection opens
      if (e.channels.size > 0) {
        newWs.once('open', () => {
          newWs.send(JSON.stringify({ op: 'subscribe', args: [...e.channels] }));
        });
      }
    },
  });

  service.on('shutdown', () => ws.close());

  entry.ws = ws;

  return entry;
};

// ── Credential fetching ───────────────────────────────────────────────────────

const fetchCredentials = async (config: Config, accountId: string): Promise<Credentials> => {
  const expires  = Math.floor(Date.now() / 1000) + 60;
  const response = await fetch(`${config.bouncerUrl}/sign/ws`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${config.bouncerToken}`,
    },
    body: JSON.stringify({ accountId, expires }),
  });

  if (response.status === 401 || response.status === 403)
    throw Object.assign(new Error('Unauthorized'), { httpStatus: 401 });

  if (! response.ok)
    throw Object.assign(new Error(`Bouncer returned ${response.status}`), { httpStatus: 503 });

  return response.json() as Promise<Credentials>;
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
