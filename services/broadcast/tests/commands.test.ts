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
  url:       string;
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
 */
const autoConfirm = (ws: MockWs): void => {
  ws.send.mockImplementation((raw: string) => {
    const msg = JSON.parse(raw);

    if (msg.op === 'subscribe') {
      process.nextTick(() => {
        ws.emit('message', Buffer.from(JSON.stringify({ subscribe: msg.args[0], success: true })));
      });
    }
  });
};

// ── Service mock ──────────────────────────────────────────────────────────────

const makeService = () => {
  const stateMap: Record<string, unknown> = {};

  const config = {
    env:              'live',
    workerUuid:       'test-uuid',
    rabbitmqUrl:      'amqp://localhost',
    realtimeWsUrl:    'wss://www.bitmex.com/realtime',
    platformWsUrl:    'wss://www.bitmex.com/realtimePlatform',
    channels:         ['trade', 'quote', 'announcement'],
    bouncerUrl:       'http://bouncer:3000',
    bouncerToken:     'test-token',
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

const mockBouncer = (creds = { apiKey: 'key', expires: 9999, signature: 'sig' }) =>
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: () => Promise.resolve(creds),
  }));

// ── Module re-import (fresh pool + mock refs per test) ────────────────────────

let subscribe:   typeof import('../src/commands/commands').subscribe;
let unsubscribe: typeof import('../src/commands/commands').unsubscribe;
let mockConnect: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();

  const cmdMod = await import('../src/commands/commands');
  subscribe   = cmdMod.subscribe;
  unsubscribe = cmdMod.unsubscribe;

  const wsMod  = await import('../src/websocket');
  mockConnect = (wsMod as any).connect as ReturnType<typeof vi.fn>;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ── subscribe (guest) ─────────────────────────────────────────────────────────

describe('subscribe: guest connection', () => {
  it('sends a subscribe op on the realtime connection for a realtime channel', async () => {
    const { service } = makeService();
    const realtimeWs = makeMockWs();

    autoConfirm(realtimeWs);
    mockConnect.mockReturnValue(realtimeWs);

    await subscribe('trade', service as any, vi.fn());

    expect(realtimeWs.send).toHaveBeenCalledWith(
      JSON.stringify({ op: 'subscribe', args: ['trade'] }),
    );
  });

  it('routes a platform channel to the platform connection', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    autoConfirm(ws);
    mockConnect.mockReturnValue(ws);

    await subscribe('announcement', service as any, vi.fn());

    const [endpoint] = mockConnect.mock.calls[0];

    expect(endpoint.name).toBe('platform');
  });

  it('reuses the same connection for a second channel on the same endpoint', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    autoConfirm(ws);
    mockConnect.mockReturnValue(ws);

    await subscribe('trade', service as any, vi.fn());
    await subscribe('quote', service as any, vi.fn());

    // connect called once (first subscribe), second reuses it
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledTimes(2);
  });

  it('tracks subscribed channels', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    autoConfirm(ws);
    mockConnect.mockReturnValue(ws);

    await subscribe('trade', service as any, vi.fn());
    await subscribe('quote', service as any, vi.fn());

    // unsubscribe one — guest connection stays open
    unsubscribe('trade');

    expect(ws.close).not.toHaveBeenCalled();
  });

  it('updates service state for guest connections (health check)', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    autoConfirm(ws);
    mockConnect.mockReturnValue(ws);

    await subscribe('trade', service as any, vi.fn());

    expect(service.state('realtime')).toBe(ws);
  });
});

// ── subscribe (authenticated) ─────────────────────────────────────────────────

describe('subscribe: authenticated connection', () => {
  it('fetches credentials from bouncer with the given accountId', async () => {
    const { service, config } = makeService();
    const ws = makeMockWs();

    autoConfirm(ws);
    mockBouncer();
    mockConnect.mockReturnValue(ws);

    await subscribe('trade', service as any, vi.fn(), 'account-42');

    expect(globalThis.fetch).toHaveBeenCalledOnce();

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];

    expect(url).toBe(`${config.bouncerUrl}/sign/ws`);
    expect(JSON.parse((init as any).body).accountId).toBe('account-42');
  });

  it('passes fetched credentials to connect', async () => {
    const { service } = makeService();
    const ws = makeMockWs();
    const creds = { apiKey: 'ak-test', expires: 88888, signature: 's-test' };

    autoConfirm(ws);
    mockBouncer(creds);
    mockConnect.mockReturnValue(ws);

    await subscribe('trade', service as any, vi.fn(), 'account-42');

    const options = mockConnect.mock.calls[0][3];

    expect(options.credentials).toEqual(creds);
    expect(options.accountId).toBe('account-42');
  });

  it('does NOT update service state for authenticated connections', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    autoConfirm(ws);
    mockBouncer();
    mockConnect.mockReturnValue(ws);

    await subscribe('trade', service as any, vi.fn(), 'account-42');

    expect(service.state('realtime')).toBeUndefined();
  });

  it('rejects when bouncer returns a 401', async () => {
    const { service } = makeService();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    await expect(subscribe('trade', service as any, vi.fn(), 'account-x'))
      .rejects.toThrow('Unauthorized');
  });
});

// ── unsubscribe ───────────────────────────────────────────────────────────────

describe('unsubscribe', () => {
  it('sends an unsubscribe op on the correct connection', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    autoConfirm(ws);
    mockConnect.mockReturnValue(ws);

    await subscribe('trade', service as any, vi.fn());
    unsubscribe('trade');

    expect(ws.send).toHaveBeenLastCalledWith(
      JSON.stringify({ op: 'unsubscribe', args: ['trade'] }),
    );
  });

  it('does NOT close the guest connection even when all channels removed', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    autoConfirm(ws);
    mockConnect.mockReturnValue(ws);

    await subscribe('trade', service as any, vi.fn());
    unsubscribe('trade');

    expect(ws.close).not.toHaveBeenCalled();
  });

  it('closes an authenticated connection when last channel is removed', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    autoConfirm(ws);
    mockBouncer();
    mockConnect.mockReturnValue(ws);

    await subscribe('trade', service as any, vi.fn(), 'acct-1');
    unsubscribe('trade', 'acct-1');

    expect(ws.close).toHaveBeenCalledOnce();
  });

  it('keeps an authenticated connection open while channels remain', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    autoConfirm(ws);
    mockBouncer();
    mockConnect.mockReturnValue(ws);

    await subscribe('trade', service as any, vi.fn(), 'acct-1');
    await subscribe('quote', service as any, vi.fn(), 'acct-1');

    unsubscribe('trade', 'acct-1');

    expect(ws.close).not.toHaveBeenCalled();
  });

  it('does not throw when the pool entry does not exist', () => {
    expect(() => unsubscribe('trade', 'unknown-acct')).not.toThrow();
  });
});

// ── subscribe timeout ─────────────────────────────────────────────────────────

describe('subscribe: timeout', () => {
  it('rejects when BitMEX never sends a subscription confirmation', async () => {
    const { service } = makeService();
    const ws = makeMockWs();

    // send() is a no-op: no confirmation arrives
    mockConnect.mockReturnValue(ws);

    const p = subscribe('trade', service as any, vi.fn());

    vi.advanceTimersByTime(6_000);

    await expect(p).rejects.toThrow('timed out');
  });
});
