import type { AckResult, Venue } from './types';

const WS_URL = 'wss://stream.bybit.com/v5/public/linear';

/**
 * Bybit v5 public (linear perpetuals). Channels are raw topics
 * (`publicTrade.BTCUSDT`).
 *
 * Observed against the live endpoint:
 *   → {"op":"subscribe","args":["publicTrade.BTCUSDT"],"req_id":"publicTrade.BTCUSDT"}
 *   ← {"success":true,"ret_msg":"","conn_id":"…","req_id":"publicTrade.BTCUSDT","op":"subscribe"}
 *   ← {"topic":"publicTrade.BTCUSDT","type":"snapshot","ts":…,"data":[{…}]}
 *
 * A successful ack does **not** name the topic — `ret_msg` is empty — so the
 * `req_id` we set is the only correlator. A failure does name it, in prose:
 * `{"success":false,"ret_msg":"error:handler not found,topic:nonsense.BTCUSDT"}`.
 */
export const bybit: Venue = {
  name: 'bybit',

  endpoints: () => [{ name: 'linear', url: WS_URL }],

  endpointFor: () => 'linear',

  subscribeFrame:   (channels) => frame('subscribe', channels),
  unsubscribeFrame: (channels) => frame('unsubscribe', channels),

  matchAck: (frame, channel): AckResult => {
    const ack = frame as { op?: string; success?: boolean; req_id?: string };

    if (ack.op !== 'subscribe')  return null;
    if (ack.req_id !== channel)  return null;

    return ack.success ? 'ok' : 'failed';
  },

  /** Data frames carry a topic; acks carry `op`. */
  isData: (frame) => typeof (frame as { topic?: unknown }).topic === 'string'
                  && (frame as { op?: unknown }).op === undefined,

  describeControl: (frame) => {
    const f = frame as { op?: string; success?: boolean; ret_msg?: string; req_id?: string };

    if (f.op === 'subscribe' || f.op === 'unsubscribe')
      return `${f.op} ${f.req_id ?? ''}: success=${f.success}${f.ret_msg ? ` (${f.ret_msg})` : ''}`;

    if (f.op) return `${f.op}`;

    return null;
  },
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * The topic doubles as the `req_id`: it is echoed verbatim, so correlation
 * needs no state between send and ack.
 */
const frame = (op: 'subscribe' | 'unsubscribe', channels: string[]): string =>
  JSON.stringify({ op, args: channels, req_id: channels[0] ?? '' });
