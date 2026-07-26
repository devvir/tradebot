import type { AckResult, Venue } from './types';

const WS_URL = 'wss://ws.kraken.com/v2';

/**
 * Kraken v2 public. A subscription is a channel plus a symbol list, so channels
 * are written `<channel>:<symbol>` (e.g. `trade:BTC/USD`) — one symbol each, so
 * every subscription acks independently.
 *
 * Observed against the live endpoint:
 *   → {"method":"subscribe","params":{"channel":"trade","symbol":["BTC/USD"]}}
 *   ← {"channel":"status","type":"update","data":[{"version":"2.0.10",…}]}   (on connect)
 *   ← {"method":"subscribe","result":{"channel":"trade","symbol":"BTC/USD"},"success":true,…}
 *   ← {"channel":"trade","type":"update","data":[{…}]}
 *   ← {"channel":"heartbeat"}                                                (periodic)
 *
 * Kraken validates: an unknown channel answers
 * `{"error":"Subscription name invalid","success":false}`.
 */
export const kraken: Venue = {
  name: 'kraken',

  endpoints: () => [{ name: 'public', url: WS_URL }],

  endpointFor: () => 'public',

  subscribeFrame:   (channels) => frame('subscribe', channels),
  unsubscribeFrame: (channels) => frame('unsubscribe', channels),

  /**
   * The ack echoes channel and symbol. An error frame carries neither, so any
   * error seen while waiting is taken as this subscription's failure — nothing
   * else is in flight on the socket at that moment.
   */
  matchAck: (frame, channel): AckResult => {
    const f = frame as {
      method?: string;
      success?: boolean;
      error?:   string;
      result?:  { channel?: string; symbol?: string };
    };

    if (f.method !== 'subscribe') return null;
    if (f.success === false)      return 'failed';

    const { name, symbol } = split(channel);

    return f.result?.channel === name && f.result?.symbol === symbol ? 'ok' : null;
  },

  /**
   * Data frames name a channel and carry a payload. `status` and `heartbeat`
   * are connection chatter, and an ack has `method` instead of `type`.
   */
  isData: (frame) => {
    const f = frame as { channel?: string; type?: string; data?: unknown };

    if (typeof f.channel !== 'string')                 return false;
    if (f.channel === 'status' || f.channel === 'heartbeat') return false;

    return f.type !== undefined && f.data !== undefined;
  },

  describeControl: (frame) => {
    const f = frame as {
      channel?: string;
      method?:  string;
      success?: boolean;
      error?:   string;
      result?:  { channel?: string; symbol?: string };
      data?:    { version?: string; system?: string }[];
    };

    if (f.channel === 'heartbeat') return 'heartbeat';
    if (f.channel === 'status')    return `status: ${f.data?.[0]?.system} (v${f.data?.[0]?.version})`;
    if (f.error)                   return `error: ${f.error}`;

    if (f.method)
      return `${f.method} ${f.result?.channel}:${f.result?.symbol}: success=${f.success}`;

    return null;
  },
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** `trade:BTC/USD` → `{ name: 'trade', symbol: 'BTC/USD' }`. */
const split = (channel: string): { name: string; symbol: string } => {
  const at = channel.indexOf(':');

  return at === -1
    ? { name: channel, symbol: '' }
    : { name: channel.slice(0, at), symbol: channel.slice(at + 1) };
};

const frame = (method: 'subscribe' | 'unsubscribe', channels: string[]): string => {
  const { name, symbol } = split(channels[0] ?? '');

  return JSON.stringify({ method, params: { channel: name, symbol: [symbol] } });
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_split = split;
