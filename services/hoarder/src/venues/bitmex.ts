import { PLATFORM_CHANNELS } from '@tradebot/utils';
import {
  isBitmexDataMessage,
  isBitmexInfoMessage,
  isBitmexSubscriptionMessage,
  isBitmexUnsubscriptionMessage,
  type BitmexWebSocketMessage,
} from '@tradebot/types';
import type { AckResult, ParsedChannel, Pool, Venue } from './types';

const WS_URLS = {
  realtime: 'wss://www.bitmex.com/realtime',
  platform: 'wss://www.bitmex.com/realtimePlatform',
} as const;

/**
 * BitMEX. Two endpoints (realtime + platform) and per-liquidity-pool sockets
 * for the tables whose default stream is the fused `Aggregated` book.
 *
 * Public market data only — hoarder never subscribes to private channels, so
 * none of BitMEX's authenticated machinery (Bouncer signing, per-account
 * sockets) exists here. Private streams need one pipeline per account and get
 * their own service.
 */
export const bitmex: Venue = {
  name: 'bitmex',

  endpoints: () => [
    { name: 'realtime', url: WS_URLS.realtime },
    { name: 'platform', url: WS_URLS.platform },
  ],

  endpointFor: (channel) =>
    (PLATFORM_CHANNELS as readonly string[]).includes(parseChannel(channel).base)
      ? 'platform'
      : 'realtime',

  subscribeFrame:   (channels) => JSON.stringify({ op: 'subscribe',   args: channels }),
  unsubscribeFrame: (channels) => JSON.stringify({ op: 'unsubscribe', args: channels }),

  /**
   * The ack drops the pool suffix (acking `orderBookL2::Primary` as
   * `subscribe: "orderBookL2"` with the pool in `ack.pool`), so a match is the
   * base channel plus the ack's pool — never the full suffixed arg.
   */
  matchAck: (frame, channel): AckResult => {
    const ack = frame as { subscribe?: string; pool?: string; success?: boolean };

    if (typeof ack.subscribe !== 'string') return null;

    const { base, pool } = parseChannel(channel);

    if (ack.subscribe !== base)    return null;
    if (pool && ack.pool !== pool) return null;

    return ack.success ? 'ok' : 'failed';
  },

  isData: (frame) => isBitmexDataMessage(frame as BitmexWebSocketMessage),

  describeControl: (frame) => {
    const msg = frame as BitmexWebSocketMessage;

    if (isBitmexInfoMessage(msg))           return `info: ${msg.info} (API ${msg.version})`;
    if (isBitmexSubscriptionMessage(msg))   return `subscribed: ${msg.subscribe} (success=${msg.success})`;
    if (isBitmexUnsubscriptionMessage(msg)) return `unsubscribed: ${msg.unsubscribe} (success=${msg.success})`;

    return null;
  },

  /** One socket per pool: the pool is a property of the connection's subscriptions. */
  socketKey: (channel) => parseChannel(channel).pool ?? '',
};

// ── Channel parsing ───────────────────────────────────────────────────────────

/**
 * Split a subscription arg into its base channel and pool. Used to pick the
 * endpoint and the socket, and to match acks — never to build a subscription;
 * the channel list is written out in full in `channels.ts`.
 */
export const parseChannel = (channel: string): ParsedChannel => {
  const segments = channel.split(':');
  const last     = segments[segments.length - 1];

  if (segments.length >= 2 && (POOL_NAMES as readonly string[]).includes(last!)) {
    segments.pop();

    // Drop the empty symbol slot left by the all-symbol form (`table::Pool`).
    while (segments.length > 1 && segments[segments.length - 1] === '')
      segments.pop();

    return { base: segments.join(':'), pool: last as Pool };
  }

  return { base: channel };
};

// ── Internals ─────────────────────────────────────────────────────────────────

const POOL_NAMES: readonly Pool[] = ['Primary', 'Secondary', 'Aggregated'];
