import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BitmexClient } from '../../src/data/BitmexClient';

const okJson = <T,>(data: T): Response => ({
  ok:   true,
  json: () => Promise.resolve(data),
} as unknown as Response);

beforeEach(() => {
  /** WS opens lazily on subscribe, so no need to mock WebSocket here. */
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── fetch — URL composition ───────────────────────────────────────────────────

describe('BitmexClient.fetch URL composition', () => {
  it('hits `${restUrl}/${table}` with reverse=true and the default count', async () => {
    const f = vi.fn().mockResolvedValueOnce(okJson([]));
    vi.stubGlobal('fetch', f);

    const client = new BitmexClient('/api/v1', 'wss://x/realtime');

    await client.fetch('trade');

    const url = (f.mock.calls[0] as [string, unknown])[0];

    expect(url).toContain('/api/v1/trade?');
    expect(url).toContain('count=50');
    expect(url).toContain('reverse=true');
  });

  it('honors an explicit count and passes through extra params', async () => {
    const f = vi.fn().mockResolvedValueOnce(okJson([]));
    vi.stubGlobal('fetch', f);

    const client = new BitmexClient('/api/v1', 'wss://x/realtime');

    await client.fetch('trade', 25, { symbol: 'XBTUSD', start: 100 });

    const url = (f.mock.calls[0] as [string, unknown])[0];

    expect(url).toContain('count=25');
    expect(url).toContain('symbol=XBTUSD');
    expect(url).toContain('start=100');
  });
});

// ── fetch — headers (the x-testnet path) ──────────────────────────────────────

describe('BitmexClient.fetch headers', () => {
  it('sends headers passed to the constructor (e.g. x-testnet)', async () => {
    const f = vi.fn().mockResolvedValueOnce(okJson([]));
    vi.stubGlobal('fetch', f);

    const client = new BitmexClient('/api/v1', 'wss://x/realtime', { 'x-testnet': 'true' });

    await client.fetch('trade');

    const opts = (f.mock.calls[0] as [string, RequestInit])[1];

    expect(opts.headers).toEqual({ 'x-testnet': 'true' });
  });

  it('sends an empty headers object when none are configured (live env)', async () => {
    const f = vi.fn().mockResolvedValueOnce(okJson([]));
    vi.stubGlobal('fetch', f);

    const client = new BitmexClient('/api/v1', 'wss://x/realtime');

    await client.fetch('trade');

    const opts = (f.mock.calls[0] as [string, RequestInit])[1];

    expect(opts.headers).toEqual({});
  });
});

// ── fetch — errors ────────────────────────────────────────────────────────────

describe('BitmexClient.fetch error handling', () => {
  it('throws when the response is not OK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 500 } as Response));

    const client = new BitmexClient('/api/v1', 'wss://x/realtime');

    await expect(client.fetch('trade')).rejects.toThrow(/500/);
  });
});

// ── stream / destroy — delegated to WsClient ──────────────────────────────────

class MockWebSocket {
  static readonly OPEN   = 1;
  static readonly CLOSED = 3;
  static last: MockWebSocket | null = null;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  onopen?:    () => void;
  onmessage?: (e: MessageEvent) => void;
  onclose?:   () => void;
  onerror?:   () => void;

  constructor(public readonly url: string) {
    MockWebSocket.last = this;
  }
  open()  { this.onopen?.(); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.(); }
}

describe('BitmexClient.stream', () => {
  beforeEach(() => { vi.stubGlobal('WebSocket', MockWebSocket); MockWebSocket.last = null; });

  it('subscribes to the WS topic via the underlying WsClient', () => {
    const client = new BitmexClient('/api/v1', 'wss://x/realtime');

    client.stream('trade', vi.fn());
    MockWebSocket.last!.open();

    expect(MockWebSocket.last!.sent).toContain(JSON.stringify({ op: 'subscribe', args: ['trade'] }));
  });

  it('returns a cleanup function that unsubscribes', () => {
    const client = new BitmexClient('/api/v1', 'wss://x/realtime');

    const cleanup = client.stream('trade', vi.fn());
    MockWebSocket.last!.open();
    MockWebSocket.last!.sent = [];

    cleanup();

    expect(MockWebSocket.last!.sent).toContain(JSON.stringify({ op: 'unsubscribe', args: ['trade'] }));
  });

  it('hands messages to the handler', () => {
    const client = new BitmexClient('/api/v1', 'wss://x/realtime');
    const handler = vi.fn();

    client.stream<{ price: number }>('trade', handler);
    MockWebSocket.last!.open();

    MockWebSocket.last!.onmessage?.({
      data: JSON.stringify({ table: 'trade', action: 'insert', data: [{ price: 100 }] }),
    } as MessageEvent);

    expect(handler).toHaveBeenCalledWith('insert', [{ price: 100 }]);
  });
});

describe('BitmexClient.destroy', () => {
  beforeEach(() => { vi.stubGlobal('WebSocket', MockWebSocket); MockWebSocket.last = null; });

  it('closes the underlying WebSocket', () => {
    const client = new BitmexClient('/api/v1', 'wss://x/realtime');

    client.stream('trade', vi.fn());
    MockWebSocket.last!.open();

    const ws = MockWebSocket.last!;

    client.destroy();

    expect(ws.readyState).toBe(3);
  });
});
