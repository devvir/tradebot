import WebSocket from 'ws';
import { type Service } from '@devvir/service-kit';
import * as pool from './pool';
import { venueFor } from './venues';
import type { MessageHandler } from './types';

const SUBSCRIBE_TIMEOUT_MS = 5_000;

// ── Subscribing ───────────────────────────────────────────────────────────────

/**
 * Subscribe one channel on its venue, opening the socket if this is the first
 * channel for it. Called only at startup and on reconnect — the channel list is
 * fixed at build time, so nothing unsubscribes at runtime.
 */
export const subscribe = async (
  venue:     string,
  channel:   string,
  service:   Service,
  onMessage: MessageHandler,
): Promise<void> => {
  const v            = venueFor(venue);
  const endpointName = v.endpointFor(channel);
  const socketKey    = v.socketKey?.(channel) ?? '';
  const deadline     = Date.now() + SUBSCRIBE_TIMEOUT_MS;

  const entry = await pool.getOrConnect(venue, endpointName, service, onMessage, socketKey);

  let remaining = deadline - Date.now();

  if (remaining <= 0)
    throw Object.assign(new Error(`Subscribe to ${venue}/${channel} timed out`), { httpStatus: 503 });

  await waitForOpen(entry.ws, remaining);

  remaining = deadline - Date.now();

  if (remaining <= 0)
    throw Object.assign(new Error(`Subscribe to ${venue}/${channel} timed out`), { httpStatus: 503 });

  entry.ws.send(v.subscribeFrame([channel]));

  await waitForSubscription(entry.ws, venue, channel, remaining);

  entry.channels.add(channel);
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

/** Waits for the venue to confirm the subscription — `matchAck` owns the protocol. */
const waitForSubscription = (
  ws:        WebSocket,
  venue:     string,
  channel:   string,
  timeoutMs: number,
): Promise<void> => {
  const v = venueFor(venue);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(Object.assign(new Error(`Subscription to ${venue}/${channel} timed out`), { httpStatus: 503 }));
    }, timeoutMs);

    const onMsg = (msg: Buffer) => {
      try {
        var result = v.matchAck(JSON.parse(msg.toString()), channel);
      } catch { return; /** ignore non-JSON frames while waiting */ }

      if (result === null) return;

      clearTimeout(timer);
      ws.off('message', onMsg);

      if (result === 'ok')
        resolve();
      else
        reject(Object.assign(new Error(`Subscription to ${venue}/${channel} failed`), { httpStatus: 400 }));
    };

    ws.on('message', onMsg);
  });
};
