import type { AckResult, Venue } from './types';

const WS_URL = 'wss://ws.okx.com:8443/ws/v5/public';

/**
 * OKX v5 public. A subscription is an object, not a string, so channels are
 * written `<channel>:<instId>` (e.g. `trades:BTC-USDT`) and split here.
 *
 * Observed against the live endpoint:
 *   → {"op":"subscribe","args":[{"channel":"trades","instId":"BTC-USDT"}]}
 *   ← {"event":"subscribe","arg":{"channel":"trades","instId":"BTC-USDT"},"connId":"…"}
 *   ← {"arg":{"channel":"trades","instId":"BTC-USDT"},"data":[{…}]}
 *
 * OKX validates a subscription: an unknown channel is answered
 * `{"event":"error","code":"60018",…}`.
 */
export const okx: Venue = {
  name: 'okx',

  endpoints: () => [{ name: 'public', url: WS_URL }],

  endpointFor: () => 'public',

  subscribeFrame: (channel) => JSON.stringify({ op: 'subscribe', args: [toArg(channel)] }),

  /**
   * The ack echoes the full arg, so it matches on channel + instId. An error
   * frame carries no arg — it names the offender in prose — so any error is
   * reported as `failed`, whichever channel is asked about.
   */
  matchAck: (frame, channel): AckResult => {
    const f = frame as { event?: string; arg?: { channel?: string; instId?: string } };

    if (f.event === 'error') return 'failed';
    if (f.event !== 'subscribe') return null;

    const want = toArg(channel);

    return f.arg?.channel === want.channel && f.arg?.instId === want.instId ? 'ok' : null;
  },

  /** Data frames carry `data`; control frames carry `event`. */
  isData: (frame) => {
    const f = frame as { event?: string; data?: unknown };

    return f.event === undefined && Array.isArray(f.data);
  },

  describeControl: (frame) => {
    const f = frame as { event?: string; msg?: string; code?: string; arg?: { channel?: string; instId?: string } };

    if (f.event === 'error')       return { text: `error ${f.code}: ${f.msg}`, failure: true };
    if (f.event === 'subscribe')   return { text: `subscribed: ${f.arg?.channel}:${f.arg?.instId}` };
    if (f.event === 'unsubscribe') return { text: `unsubscribed: ${f.arg?.channel}:${f.arg?.instId}` };
    if (f.event)                   return { text: `${f.event}` };

    return null;
  },
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** `trades:BTC-USDT` → `{ channel: 'trades', instId: 'BTC-USDT' }`. */
const toArg = (channel: string): { channel: string; instId: string } => {
  const [name, instId] = channel.split(':');

  return { channel: name ?? '', instId: instId ?? '' };
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_toArg = toArg;
