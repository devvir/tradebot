import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('ws', () => ({
  default: { OPEN: 1 },
}));

vi.mock('../src/websocket', () => ({
  connect: vi.fn(),
}));

vi.mock('../src/venues', async importOriginal => (await import('./twin')).withTwin(importOriginal as never));

// ── MockWs helper ─────────────────────────────────────────────────────────────

const makeMockWs = (readyState = 1) => {
  const ws = new EventEmitter() as any;

  ws.readyState = readyState;
  ws.isPaused   = false;

  // Like ws: pausing and resuming act only on an open socket.
  ws.pause     = vi.fn(() => { if (ws.readyState === 1) ws.isPaused = true; });
  ws.resume    = vi.fn(() => { if (ws.readyState === 1) ws.isPaused = false; });
  ws.terminate = vi.fn(() => { ws.readyState = 3; });

  return ws;
};

/** Open a mock socket, as ws does when its handshake completes. */
const open = (ws: any): void => {
  ws.readyState = 1;
  ws.emit('open');
};

// ── Fresh module per test (singleton pool) ────────────────────────────────────

let poolKey:      typeof import('../src/pool').poolKey;
let getOrConnect: typeof import('../src/pool').getOrConnect;
let pauseAll:     typeof import('../src/pool').pauseAll;
let resumeAll:    typeof import('../src/pool').resumeAll;
let mockConnect:  ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();

  const mod = await import('../src/pool');

  poolKey      = mod.poolKey;
  getOrConnect = mod.getOrConnect;
  pauseAll     = mod.pauseAll;
  resumeAll    = mod.resumeAll;
  mockConnect  = (await import('../src/websocket') as any).connect;
});

const service = { on: vi.fn() } as any;

/** A service that runs its 'shutdown' listeners the way service-kit does: all at once, synchronously. */
const makeService = () => {
  const state: Record<string, unknown> = { isShuttingDown: false };
  const svc = new EventEmitter() as any;

  svc.state    = (key: string) => state[key];
  svc.setState = (key: string, value: unknown) => { state[key] = value; return value; };

  return svc;
};

afterEach(() => vi.clearAllMocks());

// ── poolKey ───────────────────────────────────────────────────────────────────

describe('poolKey', () => {
  it('keys on venue and endpoint, with an empty socket segment by default', () => {
    expect(poolKey('twin', 'realtime')).toBe('twin:realtime:');
    expect(poolKey('twin', 'platform')).toBe('twin:platform:');
  });

  it('separates venues sharing an endpoint name', () => {
    expect(poolKey('binance', 'public')).not.toBe(poolKey('okx', 'public'));
  });

  // A venue splits one endpoint across sockets via socketKey, where what tells
  // them apart is a property of the subscription.
  it('adds the socket segment so each socket key gets its own connection', () => {
    expect(poolKey('twin', 'realtime', 'Primary')).toBe('twin:realtime:Primary');
    expect(poolKey('twin', 'realtime', 'Secondary')).toBe('twin:realtime:Secondary');
  });
});

// ── getOrConnect ──────────────────────────────────────────────────────────────

describe('getOrConnect', () => {
  it('shares one entry and one connection between calls for the same key', () => {
    mockConnect.mockReturnValue(makeMockWs(0));

    const a = getOrConnect('twin', 'realtime', service, vi.fn());
    const b = getOrConnect('twin', 'realtime', service, vi.fn());

    expect(a).toBe(b);
    expect(mockConnect).toHaveBeenCalledOnce();
  });

  it('throws for an endpoint the venue does not have', () => {
    expect(() => getOrConnect('twin', 'nowhere', service, vi.fn()))
      .toThrow("Venue 'twin' has no endpoint 'nowhere'");
  });

  // Whoever subscribes learns of every socket the entry opens, so the
  // replacement after a reconnect can be subscribed like the first one was.
  it('reports the open of the first socket and of every replacement, and swaps in the replacement', () => {
    const first  = makeMockWs(0);
    const second = makeMockWs(0);
    const onOpen = vi.fn();

    mockConnect.mockReturnValue(first);

    const entry = getOrConnect('twin', 'realtime', service, vi.fn(), { onOpen });
    const { onReconnect } = mockConnect.mock.calls[0]![4];

    first.emit('open');
    expect(onOpen).toHaveBeenLastCalledWith(entry, first);

    onReconnect(second);
    expect(entry.ws).toBe(second);
    expect(onOpen).toHaveBeenCalledOnce();

    second.emit('open');
    expect(onOpen).toHaveBeenLastCalledWith(entry, second);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});

// ── pauseAll / resumeAll ──────────────────────────────────────────────────────

/** Put an entry in the pool whose current socket is `ws`. */
const connectWith = (ws: any, venue: string, endpointName: string): void => {
  mockConnect.mockReturnValueOnce(ws);
  getOrConnect(venue, endpointName, service, vi.fn());
};

describe('pauseAll and resumeAll', () => {
  it('pauses all OPEN connections', () => {
    const ws1 = makeMockWs(1);
    const ws2 = makeMockWs(1);

    connectWith(ws1, 'twin', 'realtime');
    connectWith(ws2, 'twin', 'platform');

    pauseAll();

    expect(ws1.pause).toHaveBeenCalledOnce();
    expect(ws2.pause).toHaveBeenCalledOnce();
  });

  it('resumes every paused connection', () => {
    const ws1 = makeMockWs(1);
    const ws2 = makeMockWs(1);

    connectWith(ws1, 'twin', 'realtime');
    connectWith(ws2, 'twin', 'platform');

    pauseAll();
    resumeAll();

    expect(ws1.resume).toHaveBeenCalledOnce();
    expect(ws2.resume).toHaveBeenCalledOnce();
    expect(ws1.isPaused).toBe(false);
    expect(ws2.isPaused).toBe(false);
  });

  it('skips connections that are not open', () => {
    const ws1 = makeMockWs(3); // CLOSED

    connectWith(ws1, 'twin', 'realtime');

    pauseAll();

    expect(ws1.pause).not.toHaveBeenCalled();
  });

  // Backpressure is global: one paused publisher must stall every venue's
  // socket, or the unstalled ones keep filling the queue.
  it('pauses across venues', () => {
    const twinWs  = makeMockWs(1);
    const binanceWs = makeMockWs(1);

    connectWith(twinWs, 'twin', 'realtime');
    connectWith(binanceWs, 'binance', 'public');

    pauseAll();

    expect(twinWs.pause).toHaveBeenCalledOnce();
    expect(binanceWs.pause).toHaveBeenCalledOnce();
  });

  // A socket still connecting cannot be paused; it must stop reading as soon
  // as it opens, before its subscriptions are sent.
  it('pauses a socket that opens during a pause, before onOpen runs', () => {
    const ws     = makeMockWs(0);
    const onOpen = vi.fn(() => expect(ws.isPaused).toBe(true));

    mockConnect.mockReturnValue(ws);
    getOrConnect('twin', 'realtime', service, vi.fn(), { onOpen });

    pauseAll();
    expect(ws.isPaused).toBe(false);

    open(ws);

    expect(ws.isPaused).toBe(true);
    expect(onOpen).toHaveBeenCalledOnce();

    resumeAll();
    expect(ws.isPaused).toBe(false);
  });

  it('pauses a reconnected socket that opens during a pause, and resumes it', () => {
    const first  = makeMockWs(0);
    const second = makeMockWs(0);

    mockConnect.mockReturnValue(first);
    getOrConnect('twin', 'realtime', service, vi.fn());

    const { onReconnect } = mockConnect.mock.calls[0]![4];

    open(first);
    pauseAll();
    expect(first.isPaused).toBe(true);

    first.readyState = 3;
    onReconnect(second);
    open(second);

    expect(second.isPaused).toBe(true);

    resumeAll();
    expect(second.isPaused).toBe(false);
  });

  it('leaves a socket that opens after the resume reading', () => {
    const ws = makeMockWs(0);

    mockConnect.mockReturnValue(ws);
    getOrConnect('twin', 'realtime', service, vi.fn());

    pauseAll();
    resumeAll();
    open(ws);

    expect(ws.pause).not.toHaveBeenCalled();
  });

  describe('a long pause', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('is warned about once it passes 30 s', async () => {
      const { logger } = await import('@devvir/service-kit');

      pauseAll();
      pauseAll();

      vi.advanceTimersByTime(29_999);
      expect(logger.warn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(logger.warn).toHaveBeenCalledOnce();
    });

    it('is not warned about when resumed in time', async () => {
      const { logger } = await import('@devvir/service-kit');

      pauseAll();
      vi.advanceTimersByTime(10_000);
      resumeAll();
      vi.advanceTimersByTime(60_000);

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});

// ── Shutdown ──────────────────────────────────────────────────────────────────

describe('shutdown', () => {
  it('marks the service as shutting down and stops every current socket, a reconnected one included', () => {
    const svc    = makeService();
    const first  = makeMockWs(0);
    const second = makeMockWs(0);
    const other  = makeMockWs(0);

    mockConnect.mockReturnValueOnce(first).mockReturnValueOnce(other);

    const entry = getOrConnect('twin', 'realtime', svc, vi.fn());
    getOrConnect('twin', 'platform', svc, vi.fn());

    const { onReconnect } = mockConnect.mock.calls[0]![4];

    open(first);
    first.readyState = 3;
    onReconnect(second);
    open(second);
    open(other);

    svc.emit('shutdown', svc, 'SIGTERM');

    expect(svc.state('isShuttingDown')).toBe(true);
    expect(entry.ws).toBe(second);
    expect(second.pause).toHaveBeenCalled();
    expect(second.terminate).toHaveBeenCalledOnce();
    expect(other.terminate).toHaveBeenCalledOnce();
  });

  // Aborting the signal is what cancels a pending reconnect and refuses any
  // later one (see websocket.test.ts).
  it('aborts the signal every connection was made with', () => {
    const svc = makeService();

    mockConnect.mockImplementation(() => makeMockWs(0));

    getOrConnect('twin', 'realtime', svc, vi.fn());
    getOrConnect('twin', 'platform', svc, vi.fn());

    const signals = mockConnect.mock.calls.map(call => call[4].signal as AbortSignal);

    expect(signals.every(s => ! s.aborted)).toBe(true);

    svc.emit('shutdown', svc, 'SIGTERM');

    expect(signals.every(s => s.aborted)).toBe(true);
  });

  it('listens for the shutdown once, however many sockets the pool has', () => {
    const svc = makeService();

    mockConnect.mockImplementation(() => makeMockWs(0));

    getOrConnect('twin', 'realtime', svc, vi.fn());
    getOrConnect('twin', 'platform', svc, vi.fn());
    getOrConnect('twin', 'realtime', svc, vi.fn(), { socketKey: 'Secondary' });

    expect(svc.listenerCount('shutdown')).toBe(1);
  });

  it('keeps an entry whose socket was never made, with no socket', () => {
    const svc = makeService();

    mockConnect.mockReturnValue(null);

    const entry = getOrConnect('twin', 'realtime', svc, vi.fn());

    expect(entry.ws).toBeNull();
    expect(() => svc.emit('shutdown', svc, 'SIGTERM')).not.toThrow();
  });
});
