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
  ws.pause  = vi.fn();
  ws.resume = vi.fn();

  return ws;
};

// ── Fresh module per test (singleton pool) ────────────────────────────────────

let poolKey:      typeof import('../src/pool').poolKey;
let get:          typeof import('../src/pool').get;
let set:          typeof import('../src/pool').set;
let getOrConnect: typeof import('../src/pool').getOrConnect;
let pauseAll:     typeof import('../src/pool').pauseAll;
let resumeAll:    typeof import('../src/pool').resumeAll;
let mockConnect:  ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();

  const mod = await import('../src/pool');

  poolKey      = mod.poolKey;
  get          = mod.get;
  set          = mod.set;
  getOrConnect = mod.getOrConnect;
  pauseAll     = mod.pauseAll;
  resumeAll    = mod.resumeAll;
  mockConnect  = (await import('../src/websocket') as any).connect;
});

const service = { on: vi.fn() } as any;

afterEach(() => vi.clearAllMocks());

// ── poolKey ───────────────────────────────────────────────────────────────────

describe('poolKey', () => {
  it('keys on exchange and endpoint, with an empty socket segment by default', () => {
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
    expect(get('twin:realtime:')).toBe(a);
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

describe('pauseAll and resumeAll', () => {
  it('pauses all OPEN connections', () => {
    const ws1 = makeMockWs(1);
    const ws2 = makeMockWs(1);

    set('twin:realtime:', { ws: ws1, channels: new Set() });
    set('twin:platform:', { ws: ws2, channels: new Set() });

    pauseAll();

    expect(ws1.pause).toHaveBeenCalledOnce();
    expect(ws2.pause).toHaveBeenCalledOnce();
  });

  it('resumes all OPEN connections', () => {
    const ws1 = makeMockWs(1);

    set('twin:realtime:', { ws: ws1, channels: new Set() });

    resumeAll();

    expect(ws1.resume).toHaveBeenCalledOnce();
  });

  it('skips connections that are not open', () => {
    const ws1 = makeMockWs(3); // CLOSED

    set('twin:realtime:', { ws: ws1, channels: new Set() });

    pauseAll();

    expect(ws1.pause).not.toHaveBeenCalled();
  });

  // Backpressure is global: one paused publisher must stall every venue's
  // socket, or the unstalled ones keep filling the queue.
  it('pauses across venues', () => {
    const twinWs  = makeMockWs(1);
    const binanceWs = makeMockWs(1);

    set('twin:realtime:', { ws: twinWs,  channels: new Set() });
    set('binance:public:',  { ws: binanceWs, channels: new Set() });

    pauseAll();

    expect(twinWs.pause).toHaveBeenCalledOnce();
    expect(binanceWs.pause).toHaveBeenCalledOnce();
  });
});
