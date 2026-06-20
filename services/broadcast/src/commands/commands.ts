import WebSocket from 'ws';
import { logger, type Service } from '@devvir/service-kit';
import * as pool from '../pool';
import { parseChannel } from '../pools';
import type { MessageHandler } from '../types';

const SUBSCRIBE_TIMEOUT_MS = 5_000;

// ── Commands ──────────────────────────────────────────────────────────────────

export const subscribe = async (
  channel:   string,
  service:   Service,
  onMessage: MessageHandler,
  accountId?: string,
): Promise<void> => {
  const endpointName = pool.endpointForChannel(channel);
  const deadline     = Date.now() + SUBSCRIBE_TIMEOUT_MS;

  const { pool: poolFilter } = parseChannel(channel);

  const entry = await pool.getOrConnect(endpointName, service, onMessage, accountId, poolFilter);

  let remaining = deadline - Date.now();

  if (remaining <= 0)
    throw Object.assign(new Error(`Subscribe to ${channel} timed out`), { httpStatus: 503 });

  await waitForOpen(entry.ws, remaining);

  remaining = deadline - Date.now();

  if (remaining <= 0)
    throw Object.assign(new Error(`Subscribe to ${channel} timed out`), { httpStatus: 503 });

  entry.ws.send(JSON.stringify({ op: 'subscribe', args: [ channel ] }));

  await waitForSubscription(entry.ws, channel, remaining);

  entry.channels.add(channel);
};

export const unsubscribe = (channel: string, accountId?: string, keepOpen = false): void => {
  const endpointName = pool.endpointForChannel(channel);
  const { pool: poolFilter } = parseChannel(channel);
  const key          = pool.poolKey(endpointName, accountId, poolFilter);
  const entry        = pool.get(key);

  if (! entry)
    return logger.warn({ channel, accountId }, 'Unsubscribe: no pool entry found');

  entry.ws.send(JSON.stringify({ op: 'unsubscribe', args: [channel] }));
  entry.channels.delete(channel);

  // Guest connections persist; close authenticated connections when idle
  if (accountId && entry.channels.size === 0 && ! keepOpen) {
    entry.ws.close();
    pool.remove(key);
  }
};

// ── Async helpers ─────────────────────────────────────────────────────────────

const waitForOpen = (ws: WebSocket, timeoutMs: number): Promise<void> => {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('open',  onOpen);
      ws.off('error', onError);
      reject(Object.assign(new Error('Connection timed out'), { httpStatus: 503 }));
    }, timeoutMs);

    const onOpen = () => {
      clearTimeout(timer);
      ws.off('error', onError);
      resolve();
    };

    const onError = (err: Error) => {
      clearTimeout(timer);
      ws.off('open', onOpen);
      reject(Object.assign(err, { httpStatus: 503 }));
    };

    ws.once('open',  onOpen);
    ws.once('error', onError);
  });
};

const waitForSubscription = (ws: WebSocket, channel: string, timeoutMs: number): Promise<void> => {
  // The ack drops the pool suffix (acking `orderBookL2::Primary` as
  // `subscribe: "orderBookL2"` with the pool in `ack.pool`), so match on the base
  // channel plus the ack's pool rather than the full suffixed arg.
  const { base, pool: poolFilter } = parseChannel(channel);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(Object.assign(new Error(`Subscription to ${channel} timed out`), { httpStatus: 503 }));
    }, timeoutMs);

    const onMsg = (msg: Buffer) => {
      try {
        const data = JSON.parse(msg.toString());

        if (data.subscribe === base && (! poolFilter || data.pool === poolFilter)) {
          clearTimeout(timer);

          ws.off('message', onMsg);

          if (data.success)
            resolve();
          else
            reject(Object.assign(new Error(`Subscription to ${channel} failed`), { httpStatus: 400 }));
        }
      } catch { /** ignore non-JSON frames while waiting */ }
    };

    ws.on('message', onMsg);
  });
};
