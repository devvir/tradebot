import type { AckResult, Venue } from './types';

const WS_URL = 'wss://stream.binance.com:9443/ws';

/**
 * Binance spot. Channels are raw stream names (`btcusdt@aggTrade`), sent one
 * SUBSCRIBE frame at a time on a single socket.
 *
 * Observed against the live endpoint:
 *   → {"method":"SUBSCRIBE","params":["btcusdt@aggTrade"],"id":"btcusdt-aggTrade"}
 *   ← {"result":null,"id":"btcusdt-aggTrade"}
 *   ← {"e":"aggTrade","E":…,"s":"BTCUSDT",…}
 *
 * **The ack does not name the channel and does not validate it.** Subscribing
 * to `btcusdt@nonsense` is answered `{"result":null,…}` exactly like a real
 * stream, so a typo here fails silently — the socket simply never carries that
 * data. Confirmation is by request id only; treat "subscribed" as "the request
 * was well-formed", not "the stream exists".
 *
 * Futures (`wss://fstream.binance.com`) is deliberately absent: it accepts a
 * subscribe and then delivers nothing from our network, on both the `/ws` and
 * combined-stream paths, while spot streams normally and the futures REST API
 * answers. Add it once it can be verified from wherever hoarder runs.
 */
export const binance: Venue = {
  name: 'binance',

  endpoints: () => [{ name: 'public', url: WS_URL }],

  endpointFor: () => 'public',

  subscribeFrame:   (channels) => frame('SUBSCRIBE', channels),
  unsubscribeFrame: (channels) => frame('UNSUBSCRIBE', channels),

  /**
   * Correlates on the request id, since the ack carries nothing else. The id is
   * derived from the channel rather than counted, so it can be recomputed here
   * without the adapter holding state between send and ack.
   */
  matchAck: (frame, channel): AckResult => {
    const ack = frame as { id?: string | number; result?: unknown; error?: { msg?: string } };

    if (ack.id === undefined || ack.id !== requestId(channel)) return null;

    return ack.error ? 'failed' : 'ok';
  },

  /** Data frames carry an event type; acks and errors carry `id`/`error` instead. */
  isData: (frame) => typeof (frame as { e?: unknown }).e === 'string',

  describeControl: (frame) => {
    const f = frame as { id?: string | number; result?: unknown; error?: { code?: number; msg?: string } };

    if (f.error)          return `error ${f.error.code}: ${f.error.msg} (id=${f.id})`;
    if (f.id !== undefined) return `ack id=${f.id}`;

    return null;
  },
};

// ── Internals ─────────────────────────────────────────────────────────────────

const frame = (method: 'SUBSCRIBE' | 'UNSUBSCRIBE', channels: string[]): string =>
  JSON.stringify({ method, params: channels, id: requestId(channels[0] ?? '') });

/**
 * Binance rejects a request id that is not an integer or a string matching
 * `^[a-zA-Z0-9-_]{1,36}$` — verified: sending the raw channel closes the socket
 * with 1008, because `@` is not allowed. Substituting the offending characters
 * keeps the id derivable from the channel and inside the 36-char limit.
 */
const requestId = (channel: string): string =>
  channel.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 36);

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_requestId = requestId;
