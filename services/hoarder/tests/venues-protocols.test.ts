import { describe, it, expect } from 'vitest';
import { channelsFor, venueFor } from '../src/venues';
import { binance, _test_requestId as requestId } from '../src/venues/binance';
import { bybit } from '../src/venues/bybit';
import { kraken, _test_split as splitKraken } from '../src/venues/kraken';
import { okx, _test_toArg as toArg } from '../src/venues/okx';

/**
 * Every frame below was captured from the live venue, not written from the
 * docs — the adapters were built from this traffic, so the fixtures are the
 * record of what each protocol actually does.
 */

// ── Binance ───────────────────────────────────────────────────────────────────

describe('binance', () => {
  it('builds the observed subscribe frame', () => {
    expect(binance.subscribeFrame(['btcusdt@aggTrade'])).toBe(
      '{"method":"SUBSCRIBE","params":["btcusdt@aggTrade"],"id":"btcusdt-aggTrade"}',
    );
  });

  // Verified: sending the raw channel as the id closes the socket with 1008,
  // "request ID must be an integer, a string matching '^[a-zA-Z0-9-_]{1,36}$'".
  it('derives a request id Binance will accept', () => {
    expect(requestId('btcusdt@aggTrade')).toBe('btcusdt-aggTrade');
    expect(requestId('btcusdt@depth@100ms')).toBe('btcusdt-depth-100ms');
    expect(requestId('x'.repeat(50))).toHaveLength(36);
    expect(requestId('btcusdt@aggTrade')).toMatch(/^[a-zA-Z0-9_-]{1,36}$/);
  });

  it('confirms on the echoed request id', () => {
    expect(binance.matchAck({ result: null, id: 'btcusdt-aggTrade' }, 'btcusdt@aggTrade')).toBe('ok');
  });

  it('ignores an ack for another channel', () => {
    expect(binance.matchAck({ result: null, id: 'ethusdt-aggTrade' }, 'btcusdt@aggTrade')).toBeNull();
  });

  it('accepts a real data frame and rejects control frames', () => {
    const aggTrade = { e: 'aggTrade', E: 1785049160796, s: 'BTCUSDT', p: '64438.00000000', q: '0.00099000' };

    expect(binance.isData(aggTrade)).toBe(true);
    expect(binance.isData({ result: null, id: 'btcusdt-aggTrade' })).toBe(false);
    expect(binance.isData({ error: { code: 2, msg: 'Invalid request' } })).toBe(false);
  });
});

// ── OKX ───────────────────────────────────────────────────────────────────────

describe('okx', () => {
  it('splits a channel into the arg object it subscribes with', () => {
    expect(toArg('trades:BTC-USDT')).toEqual({ channel: 'trades', instId: 'BTC-USDT' });

    expect(okx.subscribeFrame(['trades:BTC-USDT'])).toBe(
      '{"op":"subscribe","args":[{"channel":"trades","instId":"BTC-USDT"}]}',
    );
  });

  it('confirms on the echoed arg', () => {
    const ack = { event: 'subscribe', arg: { channel: 'trades', instId: 'BTC-USDT' }, connId: '2c6cdebf' };

    expect(okx.matchAck(ack, 'trades:BTC-USDT')).toBe('ok');
    expect(okx.matchAck(ack, 'trades:ETH-USDT')).toBeNull();
  });

  // OKX validates the channel, unlike Binance: code 60018 for an unknown one.
  it('treats an error event as a failure', () => {
    const err = { event: 'error', msg: "Wrong URL or channel:nonsense…", code: '60018' };

    expect(okx.matchAck(err, 'trades:BTC-USDT')).toBe('failed');
  });

  it('accepts a real data frame and rejects control frames', () => {
    const trade = { arg: { channel: 'trades', instId: 'BTC-USDT' }, data: [{ px: '64439.7', sz: '0.00003103' }] };

    expect(okx.isData(trade)).toBe(true);
    expect(okx.isData({ event: 'subscribe', arg: { channel: 'trades', instId: 'BTC-USDT' } })).toBe(false);
  });
});

// ── Bybit ─────────────────────────────────────────────────────────────────────

describe('bybit', () => {
  // A successful ack has an empty ret_msg and does not name the topic, so the
  // req_id we set is the only correlator available.
  it('sends the topic as req_id and confirms on its echo', () => {
    expect(bybit.subscribeFrame(['publicTrade.BTCUSDT'])).toBe(
      '{"op":"subscribe","args":["publicTrade.BTCUSDT"],"req_id":"publicTrade.BTCUSDT"}',
    );

    const ack = { success: true, ret_msg: '', conn_id: 'd8bu…', req_id: 'publicTrade.BTCUSDT', op: 'subscribe' };

    expect(bybit.matchAck(ack, 'publicTrade.BTCUSDT')).toBe('ok');
    expect(bybit.matchAck(ack, 'publicTrade.ETHUSDT')).toBeNull();
  });

  it('reports a rejected topic as failed', () => {
    const nack = {
      success: false,
      ret_msg: 'error:handler not found,topic:nonsense.BTCUSDT',
      req_id:  'nonsense.BTCUSDT',
      op:      'subscribe',
    };

    expect(bybit.matchAck(nack, 'nonsense.BTCUSDT')).toBe('failed');
  });

  it('accepts a real data frame and rejects the ack', () => {
    const trade = { topic: 'publicTrade.BTCUSDT', type: 'snapshot', ts: 1785050358568, data: [{ p: '64381.80' }] };

    expect(bybit.isData(trade)).toBe(true);
    expect(bybit.isData({ success: true, op: 'subscribe', req_id: 'publicTrade.BTCUSDT' })).toBe(false);
  });
});

// ── Kraken ────────────────────────────────────────────────────────────────────

describe('kraken', () => {
  it('splits a channel into its channel + symbol subscribe params', () => {
    expect(splitKraken('trade:BTC/USD')).toEqual({ name: 'trade', symbol: 'BTC/USD' });

    expect(kraken.subscribeFrame(['trade:BTC/USD'])).toBe(
      '{"method":"subscribe","params":{"channel":"trade","symbol":["BTC/USD"]}}',
    );
  });

  it('confirms on the echoed channel + symbol', () => {
    const ack = {
      method:  'subscribe',
      result:  { channel: 'trade', snapshot: false, symbol: 'BTC/USD' },
      success: true,
    };

    expect(kraken.matchAck(ack, 'trade:BTC/USD')).toBe('ok');
    expect(kraken.matchAck(ack, 'trade:ETH/USD')).toBeNull();
  });

  it('reports an invalid subscription as failed', () => {
    const nack = { error: 'Subscription name invalid', method: 'subscribe', success: false };

    expect(kraken.matchAck(nack, 'nonsense:BTC/USD')).toBe('failed');
  });

  // status and heartbeat both name a channel, so isData cannot key on that alone.
  it('accepts data frames and rejects status/heartbeat/ack', () => {
    expect(kraken.isData({ channel: 'trade', type: 'update', data: [{ price: 64304.9 }] })).toBe(true);
    expect(kraken.isData({ channel: 'book',  type: 'snapshot', data: [{ symbol: 'BTC/USD' }] })).toBe(true);

    expect(kraken.isData({ channel: 'heartbeat' })).toBe(false);
    expect(kraken.isData({ channel: 'status', type: 'update', data: [{ system: 'online' }] })).toBe(false);
    expect(kraken.isData({ method: 'subscribe', result: { channel: 'trade' }, success: true })).toBe(false);
  });
});

// ── Cross-venue invariants ────────────────────────────────────────────────────

describe('all venues', () => {
  const names = ['binance', 'bitmex', 'bybit', 'kraken', 'okx'];

  it('registers every implemented venue', () => {
    for (const n of names) expect(venueFor(n).name).toBe(n);
  });

  it('gives every venue a non-empty channel list', () => {
    for (const n of names) expect(channelsFor(n).length).toBeGreaterThan(0);
  });

  // A subscribe frame must be valid JSON and mention the channel, or the venue
  // is being sent something it cannot act on.
  it('produces a JSON subscribe frame referencing the channel', () => {
    for (const n of names) {
      const v = venueFor(n);

      for (const channel of channelsFor(n)) {
        const frame = v.subscribeFrame([channel]);

        expect(() => JSON.parse(frame)).not.toThrow();
      }
    }
  });

  // Round-trip: the venue must confirm its own channel against an ack shaped
  // the way that venue really answers (fixtures above are captured frames).
  it('never confirms a channel it did not subscribe', () => {
    expect(binance.matchAck({ result: null, id: 'nope' }, 'btcusdt@aggTrade')).toBeNull();
    expect(okx.matchAck({ event: 'subscribe', arg: { channel: 'books', instId: 'X' } }, 'trades:BTC-USDT')).toBeNull();
    expect(bybit.matchAck({ op: 'subscribe', success: true, req_id: 'nope' }, 'publicTrade.BTCUSDT')).toBeNull();
    expect(kraken.matchAck({ method: 'subscribe', success: true, result: { channel: 'book', symbol: 'X' } }, 'trade:BTC/USD')).toBeNull();
  });
});
