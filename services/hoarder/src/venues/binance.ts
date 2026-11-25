import type { AckResult, Venue } from './types';

const WS_URL = 'wss://stream.binance.com:9443/ws';

/**
 * Binance spot only (`wss://stream.binance.com:9443/ws`); Binance futures is
 * not collected. Channels are raw stream names (`btcusdt@aggTrade`), sent one
 * SUBSCRIBE frame each on a single socket, with a request id derived from the
 * channel.
 *
 * Binance acknowledges a stream that does not exist exactly as a real one, so
 * a channel here counts as confirmed once its request is acknowledged, whether
 * or not data follows. For the venue's endpoints, frames and acks, see the
 * *WebSocket* section of `docs/venues/BINANCE.md`.
 */
export const binance: Venue = {
  name: 'binance',

  endpoints: () => [{ name: 'public', url: WS_URL }],

  endpointFor: () => 'public',

  subscribeFrame: (channel) => frame(channel),

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

  /**
   * Data by exclusion: a frame is control when it has a control shape, and data
   * otherwise, because not every stream carries an event type (`bookTicker` and
   * partial-depth frames have no `e`, and `…@arr` streams are arrays). An array
   * is data; an object with `error` is control, with or without an `id`; an
   * object with both `id` and `result` is an ack. Anything that is neither an
   * object nor an array is control.
   */
  isData: (frame) => {
    if (Array.isArray(frame))                        return true;
    if (typeof frame !== 'object' || frame === null) return false;
    if ('error' in frame)                            return false;
    if ('id' in frame && 'result' in frame)          return false;

    return true;
  },

  describeControl: (frame) => {
    const f = frame as { id?: string | number; result?: unknown; error?: { code?: number; msg?: string } };

    if (f.error)            return { text: `error ${f.error.code}: ${f.error.msg} (id=${f.id})`, failure: true };
    if (f.id !== undefined) return { text: `ack id=${f.id}` };

    return null;
  },
};

// ── Internals ─────────────────────────────────────────────────────────────────

const frame = (channel: string): string =>
  JSON.stringify({ method: 'SUBSCRIBE', params: [channel], id: requestId(channel) });

/**
 * A request id Binance accepts (its rule is in `docs/venues/BINANCE.md`): every
 * character outside `[a-zA-Z0-9_-]` becomes `-`, and the id is cut to 36
 * characters, so it stays derivable from the channel.
 */
const requestId = (channel: string): string =>
  channel.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 36);

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_requestId = requestId;
