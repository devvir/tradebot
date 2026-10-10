import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('ws', () => ({
  default: { OPEN: 1 },
}));

// ── MockWs helper ─────────────────────────────────────────────────────────────

const makeMockWs = (readyState = 1) => {
  const ws = new EventEmitter() as any;

  ws.readyState = readyState;
  ws.pause  = vi.fn();
  ws.resume = vi.fn();

  return ws;
};

// ── Fresh module per test (singleton pool) ────────────────────────────────────

let poolKey:   typeof import('../src/pool').poolKey;
let set:       typeof import('../src/pool').set;
let pauseAll:  typeof import('../src/pool').pauseAll;
let resumeAll: typeof import('../src/pool').resumeAll;

beforeEach(async () => {
  vi.resetModules();

  const mod = await import('../src/pool');

  poolKey   = mod.poolKey;
  set       = mod.set;
  pauseAll  = mod.pauseAll;
  resumeAll = mod.resumeAll;
});

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
