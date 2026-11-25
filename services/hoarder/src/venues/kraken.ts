import type { AckResult, Venue } from './types';

const WS_URL = 'wss://ws.kraken.com/v2';

/**
 * Kraken v2 public (`wss://ws.kraken.com/v2`). Channels are written
 * `<channel>:<symbol>` (e.g. `trade:BTC/USD`), and each is subscribed with one
 * symbol, so every subscription is acknowledged on its own. For the venue's
 * endpoint, frames, acks and rejections, see `docs/venues/KRAKEN.md`.
 */
export const kraken: Venue = {
  name: 'kraken',

  endpoints: () => [{ name: 'public', url: WS_URL }],

  endpointFor: () => 'public',

  subscribeFrame:   (channel) => frame('subscribe', channel),
  unsubscribeFrame: (channel) => frame('unsubscribe', channel),

  /**
   * The ack echoes channel and symbol. A rejection carries neither, so any
   * `success: false` answer to a subscribe is reported as `failed`, whichever
   * channel is asked about.
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

    if (f.channel === 'heartbeat') return { text: 'heartbeat' };
    if (f.channel === 'status')    return { text: `status: ${f.data?.[0]?.system} (v${f.data?.[0]?.version})` };
    if (f.error)                   return { text: `error: ${f.error}`, failure: true };

    if (f.method) {
      return {
        text:    `${f.method} ${f.result?.channel}:${f.result?.symbol}: success=${f.success}`,
        failure: f.success === false,
      };
    }

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

const frame = (method: 'subscribe' | 'unsubscribe', channel: string): string => {
  const { name, symbol } = split(channel);

  return JSON.stringify({ method, params: { channel: name, symbol: [symbol] } });
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_split = split;
