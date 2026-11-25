import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Mocks (hoisted by Vitest) ─────────────────────────────────────────────────

vi.mock('ws', () => ({
  default: { OPEN: 1 },
}));

vi.mock('../src/websocket', () => ({
  connect: vi.fn(),
}));

// The subscriber is tried against a venue of the tests' own — see ./twin.
vi.mock('../src/venues', async importOriginal => (await import('./twin')).withTwin(importOriginal as never));

// ── Mock WS factory ───────────────────────────────────────────────────────────

type MockWs = EventEmitter & {
  url:        string;
  readyState: number;
  send:       ReturnType<typeof vi.fn>;
  close:      ReturnType<typeof vi.fn>;
  pause:      ReturnType<typeof vi.fn>;
  resume:     ReturnType<typeof vi.fn>;
};

const makeMockWs = (url = '', readyState = 1 /** OPEN */): MockWs => {
  const ws = new EventEmitter() as MockWs;

  ws.url        = url;
  ws.readyState = readyState;
  ws.send   = vi.fn();
  ws.close  = vi.fn();
  ws.pause  = vi.fn();
  ws.resume = vi.fn();

  return ws;
};

/**
 * Configure a mockWs so that a subscribe `send` call automatically emits the
 * subscription confirmation on the next tick (process.nextTick is not faked by
 * vi.useFakeTimers).
 *
 * As the twin acks: the ack drops the `::Pool` suffix, acking the bare table
 * with the pool carried separately in `ack.pool`.
 */
const autoConfirm = (ws: MockWs): void => {
  ws.send.mockImplementation((raw: string) => {
    const msg = JSON.parse(raw);

    if (msg.op === 'subscribe') {
      const [base, pool] = String(msg.args[0]).split('::');

      process.nextTick(() => {
        ws.emit('message', Buffer.from(JSON.stringify({ subscribe: base, pool, success: true })));
      });
    }
  });
};

/** A socket as `connect` really returns it: still connecting. */
const connectingWs = (): MockWs => makeMockWs('', 0);

const open = (ws: MockWs): void => {
  ws.readyState = 1;
  ws.emit('open');
};

const close = (ws: MockWs): void => {
  ws.readyState = 3;
  ws.emit('close', 1006, Buffer.from(''));
};

const reply = (ws: MockWs, frame: unknown): void => {
  ws.emit('message', Buffer.from(JSON.stringify(frame)));
};

/** The frames sent on a socket, parsed. */
const sent = (ws: MockWs): any[] => ws.send.mock.calls.map(([raw]) => JSON.parse(raw as string));

/** Let queued promise callbacks run without moving the clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

// ── Service mock ──────────────────────────────────────────────────────────────

const makeService = () => {
  const stateMap: Record<string, unknown> = {};

  const config = {
    workerUuid:  'test-uuid',
    rabbitmqUrl: 'amqp://localhost',
    venues:      ['twin'],
  };

  return {
    service: {
      config:   () => config,
      state:    (key?: string) => key !== undefined ? stateMap[key] : stateMap,
      setState: (key: string, value: unknown) => { stateMap[key] = value; return value; },
      on:       vi.fn(),
    },
    config,
  };
};

// ── Module re-import (fresh pool + mock refs per test) ────────────────────────

let subscribe:   typeof import('../src/subscriptions').subscribe;
let mockConnect: ReturnType<typeof vi.fn>;
let logger:      typeof import('@devvir/service-kit').logger;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();

  subscribe = (await import('../src/subscriptions')).subscribe;
  logger    = (await import('@devvir/service-kit')).logger;

  const wsMod  = await import('../src/websocket');
  mockConnect = (wsMod as any).connect as ReturnType<typeof vi.fn>;
});

/** Hand the pool a replacement socket, as `connect` does after a reconnect. */
const reconnect = (next: MockWs, call = 0): void => {
  mockConnect.mock.calls[call]![4].onReconnect(next);
};

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ── subscribe ─────────────────────────────────────────────────────────────────

describe('subscribe', () => {
  it('sends the venue subscribe frame on the endpoint the venue chose', async () => {
    const { service } = makeService();
    const realtimeWs = makeMockWs();

    autoConfirm(realtimeWs);
    mockConnect.mockReturnValue(realtimeWs);

    await subscribe('twin', 'trade', service as any, vi.fn());

    expect(realtimeWs.send).toHaveBeenCalledWith(
      JSON.stringify({ op: 'subscribe', args: ['trade'] }),
    );
  });

  it('routes a platform channel to the platform connection', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    autoConfirm(ws);
    mockConnect.mockReturnValue(ws);

    await subscribe('twin', 'announcement', service as any, vi.fn());

    const [endpoint] = mockConnect.mock.calls[0];

    expect(endpoint.name).toBe('platform');
  });

  it('passes the venue name to connect so frames are tagged with their origin', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    autoConfirm(ws);
    mockConnect.mockReturnValue(ws);

    await subscribe('twin', 'trade', service as any, vi.fn());

    expect(mockConnect.mock.calls[0][1]).toBe('twin');
  });

  it('reuses the same connection for a second channel on the same endpoint', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    autoConfirm(ws);
    mockConnect.mockReturnValue(ws);

    await subscribe('twin', 'trade', service as any, vi.fn());
    await subscribe('twin', 'quote', service as any, vi.fn());

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledTimes(2);
  });

  it('rejects an unknown venue', async () => {
    const { service } = makeService();

    await expect(subscribe('nasdaq', 'trade', service as any, vi.fn()))
      .rejects.toThrow(/Unknown venue 'nasdaq'/);
  });
});

// ── subscribe (pooled) ────────────────────────────────────────────────────────

describe('subscribe: pooled channels', () => {
  it('opens a separate connection per pool for the same table', async () => {
    const { service } = makeService();
    const primaryWs   = makeMockWs();
    const secondaryWs = makeMockWs();

    autoConfirm(primaryWs);
    autoConfirm(secondaryWs);
    mockConnect.mockReturnValueOnce(primaryWs).mockReturnValueOnce(secondaryWs);

    await subscribe('twin', 'orderBookL2::Primary',   service as any, vi.fn());
    await subscribe('twin', 'orderBookL2::Secondary', service as any, vi.fn());

    // Same table, two pools: each is a socket key of its own, so each gets its
    // own connection (this is the whole point of the socket key).
    expect(mockConnect).toHaveBeenCalledTimes(2);

    expect(primaryWs.send).toHaveBeenCalledWith(
      JSON.stringify({ op: 'subscribe', args: ['orderBookL2::Primary'] }),
    );
    expect(secondaryWs.send).toHaveBeenCalledWith(
      JSON.stringify({ op: 'subscribe', args: ['orderBookL2::Secondary'] }),
    );
  });

  it('reuses one connection for different tables of the same pool', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    autoConfirm(ws);
    mockConnect.mockReturnValue(ws);

    await subscribe('twin', 'orderBookL2::Primary', service as any, vi.fn());
    await subscribe('twin', 'trade::Primary',       service as any, vi.fn());

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledTimes(2);
  });

  it('confirms against the suffix-dropped ack — matches on base channel + pool', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    // The twin acks `orderBookL2::Primary` as { subscribe: 'orderBookL2', pool: 'Primary' }.
    ws.send.mockImplementation((raw: string) => {
      const msg = JSON.parse(raw);

      if (msg.op === 'subscribe')
        process.nextTick(() =>
          ws.emit('message', Buffer.from(
            JSON.stringify({ subscribe: 'orderBookL2', pool: 'Primary', success: true }),
          )),
        );
    });

    mockConnect.mockReturnValue(ws);

    await expect(
      subscribe('twin', 'orderBookL2::Primary', service as any, vi.fn()),
    ).resolves.toBeUndefined();
  });

  it('does NOT confirm when the ack carries a different pool', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    // An ack for the WRONG pool (Secondary) must not satisfy a Primary subscribe.
    ws.send.mockImplementation((raw: string) => {
      const msg = JSON.parse(raw);

      if (msg.op === 'subscribe')
        process.nextTick(() =>
          ws.emit('message', Buffer.from(
            JSON.stringify({ subscribe: 'orderBookL2', pool: 'Secondary', success: true }),
          )),
        );
    });

    mockConnect.mockReturnValue(ws);

    const pending = subscribe('twin', 'orderBookL2::Primary', service as any, vi.fn());
    const settled = vi.fn();

    pending.then(settled, settled);

    // Let the (mismatched) ack fire, then run out the subscribe deadline (5s)
    // and the first retry's backoff (1s): still unconfirmed, so it is resent.
    await flush();
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(6_100);

    expect(settled).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledTimes(2);
  });
});

// ── subscribe: unconfirmed ────────────────────────────────────────────────────

describe('subscribe: unconfirmed', () => {
  // The deadline is 5s from the send, and the backoff before the resend starts
  // at 1s and doubles to a 60s cap — so sends are 5s + backoff apart.
  it('resends an unconfirmed subscribe after a backoff doubling from 1s to 60s', async () => {
    const { service } = makeService();
    const ws = makeMockWs();
    const sentAt: number[] = [];

    ws.send.mockImplementation(() => { sentAt.push(Date.now()); });
    mockConnect.mockReturnValue(ws);

    const pending = subscribe('twin', 'trade', service as any, vi.fn());
    const settled = vi.fn();

    pending.then(settled, settled);

    await vi.advanceTimersByTimeAsync(230_000);

    const gaps = sentAt.slice(1).map((t, i) => t - sentAt[i]!);

    expect(gaps).toEqual([6_000, 7_000, 9_000, 13_000, 21_000, 37_000, 65_000, 65_000]);
    expect(settled).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ venue: 'twin', channel: 'trade', retryInMs: 1_000 }),
      expect.stringMatching(/not confirmed/),
    );

    // Once the venue answers, the subscribe resolves and the resending stops.
    autoConfirm(ws);
    await vi.advanceTimersByTimeAsync(65_000);

    expect(settled).toHaveBeenCalledOnce();
    await expect(pending).resolves.toBeUndefined();

    const sends = ws.send.mock.calls.length;

    await vi.advanceTimersByTimeAsync(300_000);
    expect(ws.send).toHaveBeenCalledTimes(sends);
  });

  it('takes a late ack, arriving during the backoff, as confirmation and does not resend', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    mockConnect.mockReturnValue(ws);

    const pending = subscribe('twin', 'trade', service as any, vi.fn());

    await vi.advanceTimersByTimeAsync(5_500);   // timed out; retry due at 6s
    reply(ws, { subscribe: 'trade', success: true });

    await expect(pending).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(ws.send).toHaveBeenCalledOnce();
  });

  it('rejects when the venue answers success: false', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    ws.send.mockImplementation((raw: string) => {
      const msg = JSON.parse(raw);

      if (msg.op === 'subscribe')
        process.nextTick(() =>
          ws.emit('message', Buffer.from(JSON.stringify({ subscribe: 'trade', success: false }))),
        );
    });

    mockConnect.mockReturnValue(ws);

    await expect(subscribe('twin', 'trade', service as any, vi.fn()))
      .rejects.toThrow(/failed/);

    // A refusal is definitive: no retry on this socket, none on the next.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ws.send).toHaveBeenCalledOnce();

    const next = connectingWs();

    close(ws);
    reconnect(next);
    open(next);
    await flush();

    expect(next.send).not.toHaveBeenCalled();
  });
});

// ── subscribe: reconnect ──────────────────────────────────────────────────────

describe('subscribe: reconnect', () => {
  it('subscribes a channel whose first socket never opened on the socket replacing it', async () => {
    const { service } = makeService();
    const first = connectingWs();
    const next  = connectingWs();

    mockConnect.mockReturnValue(first);

    const pending = subscribe('twin', 'trade', service as any, vi.fn());

    close(first);   // the connect failed: no 'open', ever
    reconnect(next);
    autoConfirm(next);
    open(next);

    await expect(pending).resolves.toBeUndefined();
    expect(first.send).not.toHaveBeenCalled();
    expect(sent(next)).toEqual([{ op: 'subscribe', args: ['trade'] }]);
  });

  it('resubscribes every channel on the reconnected socket, one frame per channel', async () => {
    const { service } = makeService();
    const first = connectingWs();
    const next  = connectingWs();

    autoConfirm(first);
    mockConnect.mockReturnValue(first);

    const pending = ['trade', 'quote', 'instrument'].map(c => subscribe('twin', c, service as any, vi.fn()));

    open(first);
    await Promise.all(pending);

    close(first);
    reconnect(next);
    autoConfirm(next);
    open(next);
    await flush();

    expect(sent(next)).toEqual([
      { op: 'subscribe', args: ['trade'] },
      { op: 'subscribe', args: ['quote'] },
      { op: 'subscribe', args: ['instrument'] },
    ]);
  });

  it('includes a channel asked for after the reconnect but before the new socket opens', async () => {
    const { service } = makeService();
    const first = makeMockWs();
    const next  = connectingWs();

    autoConfirm(first);
    mockConnect.mockReturnValue(first);

    await subscribe('twin', 'trade', service as any, vi.fn());

    close(first);
    reconnect(next);

    const late = subscribe('twin', 'quote', service as any, vi.fn());

    autoConfirm(next);
    open(next);

    await expect(late).resolves.toBeUndefined();
    expect(sent(next).map(f => f.args[0])).toEqual(['trade', 'quote']);
  });

  it('retries a subscribe whose socket closed during the ack wait on the replacement, not the closed socket', async () => {
    const { service } = makeService();
    const first = makeMockWs();
    const next  = connectingWs();

    mockConnect.mockReturnValue(first);

    const pending = subscribe('twin', 'trade', service as any, vi.fn());

    await flush();
    close(first);     // before any ack, and well before the 5s deadline
    await flush();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ venue: 'twin', channel: 'trade' }),
      expect.stringMatching(/interrupted/),
    );

    await vi.advanceTimersByTimeAsync(120_000);
    expect(first.send).toHaveBeenCalledOnce();

    reconnect(next);
    autoConfirm(next);
    open(next);

    await expect(pending).resolves.toBeUndefined();
    expect(sent(next)).toEqual([{ op: 'subscribe', args: ['trade'] }]);
  });

  it('logs a channel refused on resubscribe at error, drops it, and resubscribes the rest', async () => {
    const { service } = makeService();
    const first  = makeMockWs();
    const second = connectingWs();
    const third  = connectingWs();

    autoConfirm(first);
    mockConnect.mockReturnValue(first);

    await subscribe('twin', 'trade', service as any, vi.fn());
    await subscribe('twin', 'quote', service as any, vi.fn());
    await subscribe('twin', 'instrument', service as any, vi.fn());

    // The second socket refuses `quote` and confirms the others.
    second.send.mockImplementation((raw: string) => {
      const channel = JSON.parse(raw).args[0];

      process.nextTick(() => reply(second, { subscribe: channel, success: channel !== 'quote' }));
    });

    close(first);
    reconnect(second);
    open(second);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(sent(second).map(f => f.args[0])).toEqual(['trade', 'quote', 'instrument']);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ venue: 'twin', channel: 'quote' }),
      expect.stringMatching(/rejected/),
    );

    // Dropped for good: the next socket does not ask for it again.
    close(second);
    reconnect(third);
    autoConfirm(third);
    open(third);
    await flush();

    expect(sent(third).map(f => f.args[0])).toEqual(['trade', 'instrument']);
  });

  // Kraken takes one channel per request: four channels on one socket are four
  // subscribe frames, each answered by an ack naming its channel and symbol.
  it('resubscribes all of a real venue\'s channels on its shared socket (kraken)', async () => {
    const { service } = makeService();
    const first    = connectingWs();
    const next     = connectingWs();
    const channels = ['trade:BTC/USD', 'book:BTC/USD', 'trade:ETH/USD', 'book:ETH/USD'];

    const krakenAcks = (ws: MockWs): void => {
      ws.send.mockImplementation((raw: string) => {
        const { params } = JSON.parse(raw);

        process.nextTick(() => reply(ws, {
          method:  'subscribe',
          result:  { channel: params.channel, symbol: params.symbol[0] },
          success: true,
        }));
      });
    };

    krakenAcks(first);
    mockConnect.mockReturnValue(first);

    const pending = channels.map(c => subscribe('kraken', c, service as any, vi.fn()));

    open(first);
    await Promise.all(pending);
    expect(mockConnect).toHaveBeenCalledOnce();

    close(first);
    reconnect(next);
    krakenAcks(next);
    open(next);
    await flush();

    expect(sent(next).map(f => `${f.params.channel}:${f.params.symbol.join(',')}`)).toEqual(channels);
  });
});

// ── subscribe: one ack at a time ──────────────────────────────────────────────

describe('subscribe: one ack awaited per socket', () => {
  const okxAck = (channel: string) => {
    const [name, instId] = channel.split(':');

    return { event: 'subscribe', arg: { channel: name, instId }, connId: 'c0ffee' };
  };

  // OKX error frames name no channel, so one is only attributable while a
  // single subscribe awaits its ack.
  it('sends the next channel only after the previous one is answered, so an error fails only its own', async () => {
    const { service } = makeService();
    const ws = connectingWs();

    mockConnect.mockReturnValue(ws);

    const bad  = subscribe('okx', 'nonsense:BTC-USDT', service as any, vi.fn());
    const good = subscribe('okx', 'trades:BTC-USDT',   service as any, vi.fn());

    bad.catch(() => { /** asserted below */ });

    open(ws);
    await flush();

    expect(ws.send).toHaveBeenCalledOnce();

    reply(ws, { event: 'error', code: '60018', msg: 'Wrong URL or channel:nonsense,instId:BTC-USDT' });
    await expect(bad).rejects.toThrow(/failed/);

    await flush();
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(sent(ws)[1]).toEqual({ op: 'subscribe', args: [{ channel: 'trades', instId: 'BTC-USDT' }] });

    reply(ws, okxAck('trades:BTC-USDT'));
    await expect(good).resolves.toBeUndefined();
  });

  it('starts each channel\'s ack deadline when its frame is sent, not when it was asked for', async () => {
    const { service } = makeService();
    const ws = connectingWs();

    mockConnect.mockReturnValue(ws);

    const first  = subscribe('okx', 'trades:BTC-USDT', service as any, vi.fn());
    const second = subscribe('okx', 'books:BTC-USDT',  service as any, vi.fn());

    open(ws);

    await vi.advanceTimersByTimeAsync(4_000);
    reply(ws, okxAck('trades:BTC-USDT'));
    await expect(first).resolves.toBeUndefined();

    // `books` went out at 4s: 8s after it was asked for is inside its own 5s.
    await vi.advanceTimersByTimeAsync(4_000);
    reply(ws, okxAck('books:BTC-USDT'));

    await expect(second).resolves.toBeUndefined();
    expect(ws.send).toHaveBeenCalledTimes(2);
  });
});
