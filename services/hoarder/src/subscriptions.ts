import WebSocket from 'ws';
import { logger, type Service } from '@devvir/service-kit';
import * as pool from './pool';
import { venueFor } from './venues';
import type { MessageHandler, PoolEntry } from './types';

const SUBSCRIBE_TIMEOUT_MS = 5_000;
const RETRY_MIN_MS         = 1_000;
const RETRY_MAX_MS         = 60_000;

/**
 * Subscribe state of one socket. Its subscribe requests run one at a time:
 * each sends its frame only when the previous one's wait has ended, by an
 * answer or by its deadline. A request whose wait ended without its answer
 * may still be answered later, while a later one is awaited.
 */
interface SocketTurns {
  queue:      Promise<void>;
  /** Channels queued, awaiting their ack, waiting to retry, or confirmed on this socket. */
  claimed:    Set<string>;
  confirmed:  Set<string>;
  /** The next retry delay per channel: from 1 s, doubling to 60 s. */
  delays:     Map<string, number>;
  /**
   * The channel of each request whose wait ended before its answer was read,
   * oldest first. While it names a channel other than the one awaited, a
   * refusal that names no channel may be the late answer to that request.
   */
  unanswered: string[];
}

interface Waiter {
  resolve: () => void;
  reject:  (err: Error) => void;
}

/** A venue's explicit refusal of a subscription: definitive, never retried. */
class SubscriptionRejected extends Error {
  readonly httpStatus = 400;
}

const turns   = new WeakMap<WebSocket, SocketTurns>();
const waiters = new WeakMap<PoolEntry, Map<string, Waiter[]>>();

// ── Subscribing ───────────────────────────────────────────────────────────────

/**
 * Subscribe one channel on its venue, opening its socket if this is the first
 * channel for it. The channel is subscribed on that socket and on every socket
 * that replaces it after a reconnect.
 *
 * A subscribe that the venue does not confirm in time, or whose socket closes
 * before the ack, is retried: on the same socket with a backoff while it stays
 * open, and on the replacement socket otherwise. So is one met by a refusal
 * that names no channel while an earlier request on the socket is unanswered,
 * as the refusal may be that request's. The returned promise resolves
 * the first time the venue confirms the channel and rejects when the venue
 * refuses it; a refused channel is not subscribed again. It rejects at once
 * when the service is shutting down and the socket was never made.
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

  const entry = pool.getOrConnect(venue, endpointName, service, onMessage, {
    socketKey,
    onOpen: (e, ws) => subscribeAll(venue, e, ws),
  });

  const ws = entry.ws;

  if (! ws) throw new Error(`Cannot subscribe ${venue}/${channel}: the service is shutting down`);

  entry.channels.add(channel);

  if (turns.get(ws)?.confirmed.has(channel)) return;

  const settled = new Promise<void>((resolve, reject) => addWaiter(entry, channel, { resolve, reject }));

  // A socket still connecting picks the channel up when it opens.
  if (ws.readyState === WebSocket.OPEN) request(venue, entry, ws, channel);

  return settled;
};

// ── Per-socket queue ──────────────────────────────────────────────────────────

/** Subscribe every channel the entry should carry on a socket that just opened. */
const subscribeAll = (venue: string, entry: PoolEntry, ws: WebSocket): void => {
  for (const channel of entry.channels) request(venue, entry, ws, channel);
};

/** Queue a channel's subscribe on `ws`, unless it is already queued or done there. */
const request = (venue: string, entry: PoolEntry, ws: WebSocket, channel: string): void => {
  const t = turnsOf(ws);

  if (t.claimed.has(channel)) return;

  t.claimed.add(channel);
  enqueue(venue, entry, ws, channel);
};

const enqueue = (venue: string, entry: PoolEntry, ws: WebSocket, channel: string): void => {
  const t = turnsOf(ws);

  t.queue = t.queue
    .then(() => attempt(venue, entry, ws, channel))
    .catch(err => logger.error({ err, venue, channel }, 'Subscribe attempt failed'));
};

/**
 * One subscribe of one channel. Its ack deadline starts when its turn comes,
 * not when it was queued. A socket that has been replaced, or is closing, is
 * left alone: the socket replacing it subscribes everything once it opens.
 */
const attempt = async (venue: string, entry: PoolEntry, ws: WebSocket, channel: string): Promise<void> => {
  if (! isCurrent(entry, ws) || ! entry.channels.has(channel)) return;

  try {
    await subscribeOn(ws, venue, channel, SUBSCRIBE_TIMEOUT_MS);
  } catch (err) {
    const t = turnsOf(ws);

    if (! (err instanceof SubscriptionRejected)) {
      t.unanswered.push(channel);
      return retry(venue, entry, ws, channel, err as Error);
    }

    if (! t.unanswered.some(c => c !== channel)) return drop(venue, entry, ws, channel, err);

    // The refusal may answer an older request instead: take it as the oldest
    // one's, leave this one's answer to come, and retry this channel.
    t.unanswered.shift();
    t.unanswered.push(channel);

    return retry(venue, entry, ws, channel, new Error(
      `Subscription to ${venue}/${channel}: a refusal naming no channel arrived while an earlier request was unanswered`,
    ));
  }

  confirm(entry, ws, channel);
};

/**
 * Retry an unconfirmed subscribe on the same socket after a backoff. An ack
 * that arrives late, during the backoff, confirms the channel and cancels the
 * retry.
 */
const retry = (venue: string, entry: PoolEntry, ws: WebSocket, channel: string, err: Error): void => {
  if (! isCurrent(entry, ws)) {
    logger.warn({ err, venue, channel }, 'Subscription interrupted by a disconnect; resubscribing on the next connection');
    return;
  }

  const t     = turnsOf(ws);
  const delay = t.delays.get(channel) ?? RETRY_MIN_MS;
  const v     = venueFor(venue);

  t.delays.set(channel, Math.min(delay * 2, RETRY_MAX_MS));

  logger.warn({ err, venue, channel, retryInMs: delay }, 'Subscription not confirmed; retrying');

  const onLateAck = (msg: Buffer): void => {
    try {
      var result = v.matchAck(JSON.parse(msg.toString()), channel);
    } catch { return; /** not JSON: not an ack */ }

    if (result !== 'ok') return;

    clearTimeout(timer);
    ws.off('message', onLateAck);
    confirm(entry, ws, channel);
  };

  const timer = setTimeout(() => {
    ws.off('message', onLateAck);
    enqueue(venue, entry, ws, channel);
  }, delay);

  ws.on('message', onLateAck);
};

const confirm = (entry: PoolEntry, ws: WebSocket, channel: string): void => {
  const t = turnsOf(ws);

  t.confirmed.add(channel);
  t.delays.delete(channel);
  // Any answer still to come for this channel is an ack naming it, which no wait can misread.
  t.unanswered = t.unanswered.filter(c => c !== channel);

  for (const w of takeWaiters(entry, channel)) w.resolve();
};

/**
 * A refused channel leaves the entry's set, so no later socket asks for it
 * again. Whoever is awaiting `subscribe()` gets the rejection; with nobody
 * waiting (a resubscribe after a reconnect) it is logged here.
 */
const drop = (venue: string, entry: PoolEntry, ws: WebSocket, channel: string, err: Error): void => {
  entry.channels.delete(channel);
  turnsOf(ws).claimed.delete(channel);

  const pending = takeWaiters(entry, channel);

  if (pending.length === 0)
    logger.error({ err, venue, channel }, 'Subscription rejected by the venue; channel dropped');

  for (const w of pending) w.reject(err);
};

// ── State helpers ─────────────────────────────────────────────────────────────

const isCurrent = (entry: PoolEntry, ws: WebSocket): boolean =>
  entry.ws === ws && ws.readyState === WebSocket.OPEN;

const turnsOf = (ws: WebSocket): SocketTurns => {
  let t = turns.get(ws);

  if (! t) {
    t = { queue: Promise.resolve(), claimed: new Set(), confirmed: new Set(), delays: new Map(), unanswered: [] };
    turns.set(ws, t);
  }

  return t;
};

const addWaiter = (entry: PoolEntry, channel: string, waiter: Waiter): void => {
  let byChannel = waiters.get(entry);

  if (! byChannel) {
    byChannel = new Map();
    waiters.set(entry, byChannel);
  }

  byChannel.set(channel, [...(byChannel.get(channel) ?? []), waiter]);
};

const takeWaiters = (entry: PoolEntry, channel: string): Waiter[] => {
  const byChannel = waiters.get(entry);
  const pending   = byChannel?.get(channel) ?? [];

  byChannel?.delete(channel);

  return pending;
};

// ── Async helpers ─────────────────────────────────────────────────────────────

/** Send one channel's subscribe frame on an open socket and wait for the venue's answer. */
const subscribeOn = (ws: WebSocket, venue: string, channel: string, timeoutMs: number): Promise<void> => {
  const answer = waitForSubscription(ws, venue, channel, timeoutMs);

  ws.send(venueFor(venue).subscribeFrame(channel));

  return answer;
};

/**
 * Waits for the venue to confirm the subscription — `matchAck` owns the
 * protocol. Rejects with `SubscriptionRejected` when the venue refuses it, and
 * with a plain error on timeout or when the socket closes first. A deadline
 * that falls while the socket is paused is pushed back by `timeoutMs`: a
 * paused socket reads no answer, so its silence says nothing about the venue.
 */
const waitForSubscription = (
  ws:        WebSocket,
  venue:     string,
  channel:   string,
  timeoutMs: number,
): Promise<void> => {
  const v = venueFor(venue);

  return new Promise((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer);
      ws.off('message', onMsg);
      ws.off('close', onClose);
    };

    const onDeadline = (): void => {
      if (ws.isPaused) {
        timer = setTimeout(onDeadline, timeoutMs);
        return;
      }

      done();
      reject(Object.assign(new Error(`Subscription to ${venue}/${channel} timed out`), { httpStatus: 503 }));
    };

    let timer = setTimeout(onDeadline, timeoutMs);

    const onClose = (): void => {
      done();
      reject(Object.assign(new Error(`Socket closed awaiting the ${venue}/${channel} subscription`), { httpStatus: 503 }));
    };

    const onMsg = (msg: Buffer): void => {
      try {
        var result = v.matchAck(JSON.parse(msg.toString()), channel);
      } catch { return; /** ignore non-JSON frames while waiting */ }

      if (result === null) return;

      done();

      if (result === 'ok')
        resolve();
      else
        reject(new SubscriptionRejected(`Subscription to ${venue}/${channel} failed`));
    };

    ws.on('message', onMsg);
    ws.once('close', onClose);
  });
};
