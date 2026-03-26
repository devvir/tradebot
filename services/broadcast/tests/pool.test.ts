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

let endpointForChannel: typeof import('../src/pool').endpointForChannel;
let poolKey:            typeof import('../src/pool').poolKey;
let makeEndpoint:       typeof import('../src/pool').makeEndpoint;
let get:                typeof import('../src/pool').get;
let set:                typeof import('../src/pool').set;
let pauseAll:           typeof import('../src/pool').pauseAll;
let resumeAll:          typeof import('../src/pool').resumeAll;

beforeEach(async () => {
  vi.resetModules();

  const mod = await import('../src/pool');

  endpointForChannel = mod.endpointForChannel;
  poolKey            = mod.poolKey;
  makeEndpoint       = mod.makeEndpoint;
  get                = mod.get;
  set                = mod.set;
  pauseAll           = mod.pauseAll;
  resumeAll          = mod.resumeAll;
});

afterEach(() => vi.clearAllMocks());

// ── endpointForChannel ────────────────────────────────────────────────────────

describe('endpointForChannel', () => {
  it('returns platform for platform channels', () => {
    expect(endpointForChannel('announcement')).toBe('platform');
    expect(endpointForChannel('chat')).toBe('platform');
  });

  it('returns realtime for everything else', () => {
    expect(endpointForChannel('trade')).toBe('realtime');
    expect(endpointForChannel('quote')).toBe('realtime');
    expect(endpointForChannel('orderBookL2')).toBe('realtime');
  });
});

// ── poolKey ───────────────────────────────────────────────────────────────────

describe('poolKey', () => {
  it('uses empty prefix for guest connections', () => {
    expect(poolKey('realtime')).toBe(':realtime');
    expect(poolKey('platform', undefined)).toBe(':platform');
  });

  it('uses accountId prefix for authenticated connections', () => {
    expect(poolKey('realtime', 'acct-1')).toBe('acct-1:realtime');
  });
});

// ── makeEndpoint ──────────────────────────────────────────────────────────────

describe('makeEndpoint', () => {
  const config = {
    realtimeWsUrl: 'wss://bitmex.com/realtime',
    platformWsUrl: 'wss://bitmex.com/platform',
  };

  it('builds a realtime endpoint', () => {
    expect(makeEndpoint(config as any, 'realtime')).toEqual({
      name: 'realtime',
      url:  'wss://bitmex.com/realtime',
    });
  });

  it('builds a platform endpoint', () => {
    expect(makeEndpoint(config as any, 'platform')).toEqual({
      name: 'platform',
      url:  'wss://bitmex.com/platform',
    });
  });
});

// ── pauseAll / resumeAll ──────────────────────────────────────────────────────

describe('pauseAll and resumeAll', () => {
  it('pauses all OPEN connections', () => {
    const ws1 = makeMockWs(1);
    const ws2 = makeMockWs(1);

    set(':realtime', { ws: ws1, channels: new Set() });
    set(':platform', { ws: ws2, channels: new Set() });

    pauseAll();

    expect(ws1.pause).toHaveBeenCalledOnce();
    expect(ws2.pause).toHaveBeenCalledOnce();
  });

  it('resumes all OPEN connections', () => {
    const ws1 = makeMockWs(1);

    set(':realtime', { ws: ws1, channels: new Set() });

    resumeAll();

    expect(ws1.resume).toHaveBeenCalledOnce();
  });

  it('skips connections that are not open', () => {
    const ws1 = makeMockWs(3); // CLOSED

    set(':realtime', { ws: ws1, channels: new Set() });

    pauseAll();

    expect(ws1.pause).not.toHaveBeenCalled();
  });
});
