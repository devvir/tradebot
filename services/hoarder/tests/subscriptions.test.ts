import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Mocks (hoisted by Vitest) ─────────────────────────────────────────────────

vi.mock('ws', () => ({
  default: { OPEN: 1 },
}));

vi.mock('../src/websocket', () => ({
  connect: vi.fn(),
}));

// ── Mock WS factory ───────────────────────────────────────────────────────────

type MockWs = EventEmitter & {
  url:        string;
  readyState: number;
  send:       ReturnType<typeof vi.fn>;
  close:      ReturnType<typeof vi.fn>;
  pause:      ReturnType<typeof vi.fn>;
  resume:     ReturnType<typeof vi.fn>;
};

const makeMockWs = (url = ''): MockWs => {
  const ws = new EventEmitter() as MockWs;

  ws.url        = url;
  ws.readyState = 1;  // OPEN
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
 * Faithful to BitMEX: the ack drops the `::Pool` suffix, acking the bare table
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

// ── Service mock ──────────────────────────────────────────────────────────────

const makeService = () => {
  const stateMap: Record<string, unknown> = {};

  const config = {
    workerUuid:  'test-uuid',
    rabbitmqUrl: 'amqp://localhost',
    venues:      ['bitmex'],
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

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();

  subscribe = (await import('../src/subscriptions')).subscribe;

  const wsMod  = await import('../src/websocket');
  mockConnect = (wsMod as any).connect as ReturnType<typeof vi.fn>;
});

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

    await subscribe('bitmex', 'trade', service as any, vi.fn());

    expect(realtimeWs.send).toHaveBeenCalledWith(
      JSON.stringify({ op: 'subscribe', args: ['trade'] }),
    );
  });

  it('routes a platform channel to the platform connection', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    autoConfirm(ws);
    mockConnect.mockReturnValue(ws);

    await subscribe('bitmex', 'announcement', service as any, vi.fn());

    const [endpoint] = mockConnect.mock.calls[0];

    expect(endpoint.name).toBe('platform');
  });

  it('passes the venue name to connect so frames are tagged with their origin', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    autoConfirm(ws);
    mockConnect.mockReturnValue(ws);

    await subscribe('bitmex', 'trade', service as any, vi.fn());

    expect(mockConnect.mock.calls[0][1]).toBe('bitmex');
  });

  it('reuses the same connection for a second channel on the same endpoint', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    autoConfirm(ws);
    mockConnect.mockReturnValue(ws);

    await subscribe('bitmex', 'trade', service as any, vi.fn());
    await subscribe('bitmex', 'quote', service as any, vi.fn());

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

    await subscribe('bitmex', 'orderBookL2::Primary',   service as any, vi.fn());
    await subscribe('bitmex', 'orderBookL2::Secondary', service as any, vi.fn());

    // Same table, two pools — BitMEX forbids that on one client, so each pool
    // gets its own connection (this is the whole point of the socket key).
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

    await subscribe('bitmex', 'orderBookL2::Primary', service as any, vi.fn());
    await subscribe('bitmex', 'trade::Primary',       service as any, vi.fn());

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledTimes(2);
  });

  it('confirms against the suffix-dropped ack — matches on base channel + pool', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    // BitMEX acks `orderBookL2::Primary` as { subscribe: 'orderBookL2', pool: 'Primary' }.
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
      subscribe('bitmex', 'orderBookL2::Primary', service as any, vi.fn()),
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

    const pending = subscribe('bitmex', 'orderBookL2::Primary', service as any, vi.fn());
    const settled = vi.fn();

    pending.then(settled, settled);

    // Let the (mismatched) ack fire, then run out the subscribe deadline (5s).
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(6_000);
    await expect(pending).rejects.toThrow(/timed out/);
  });
});

// ── subscribe timeout ─────────────────────────────────────────────────────────

describe('subscribe: timeout', () => {
  it('rejects when the venue never sends a subscription confirmation', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    // send() is a no-op: no confirmation arrives
    mockConnect.mockReturnValue(ws);

    const pending = subscribe('bitmex', 'trade', service as any, vi.fn());

    pending.catch(() => { /** asserted below */ });

    await vi.advanceTimersByTimeAsync(6_000);

    await expect(pending).rejects.toThrow(/timed out/);
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

    await expect(subscribe('bitmex', 'trade', service as any, vi.fn()))
      .rejects.toThrow(/failed/);
  });
});
