import WebSocket from 'ws';
import { type Service } from '@devvir/service-kit';
import type { Config, Credentials, EndpointDefinition, MessageHandler, PoolEntry } from './types';
import { PLATFORM_CHANNELS } from './channels';
import { connect } from './websocket';

const pool = new Map<string, PoolEntry>();

// ── Helpers ───────────────────────────────────────────────────────────────────

export const endpointForChannel = (channel: string): 'platform' | 'realtime' =>
  (PLATFORM_CHANNELS as readonly string[]).includes(channel) ? 'platform' : 'realtime';

// privateNotifications is a private channel on the platform endpoint — a cross-case
// that would require pool to check both PLATFORM_CHANNELS and authentication.
// BitMEX documents it as not actively used. Broadcast will never open this
// subscription; clients that try to subscribe will get a failure.

export const poolKey = (endpointName: string, accountId?: string): string =>
  `${accountId ?? ''}:${endpointName}`;

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
): Promise<PoolEntry> => {
  const key      = poolKey(endpointName, accountId);
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
    onReconnect: (newWs) => {
      const e = pool.get(key);
      if (! e) return;

      e.ws = newWs;
      if (! accountId) service.setState(endpointName, newWs);

      // Resubscribe tracked channels after the new connection opens
      if (e.channels.size > 0) {
        newWs.once('open', () => {
          newWs.send(JSON.stringify({ op: 'subscribe', args: [...e.channels] }));
        });
      }
    },
  });

  entry.ws = ws;
  if (! accountId) service.setState(endpointName, ws);

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
