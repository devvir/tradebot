import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WsClient } from '../../src/data/WsClient';

// ── MockWebSocket ─────────────────────────────────────────────────────────────

/**
 * Synchronous WebSocket double — `onopen` fires the moment we call it from
 * the test, so subscriptions and `send` calls are observable without timers.
 * Tracks each instance's `sent` payloads and lets tests drive `onmessage` /
 * `onclose` manually.
 */
class MockWebSocket {
  static readonly OPEN   = 1;
  static readonly CLOSED = 3;

  /** Latest instance — convenient for tests that only open one connection. */
  static last: MockWebSocket | null = null;

  /** Every instance created, in construction order. */
  static instances: MockWebSocket[] = [];

  static reset() {
    MockWebSocket.last = null;
    MockWebSocket.instances = [];
  }

  readyState = MockWebSocket.OPEN;
  sent:       string[] = [];

  onopen?:    () => void;
  onmessage?: (e: MessageEvent) => void;
  onclose?:   () => void;
  onerror?:   () => void;

  constructor(public readonly url: string) {
    MockWebSocket.last = this;
    MockWebSocket.instances.push(this);
  }

  open() {
    this.onopen?.();
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

beforeEach(() => {
  MockWebSocket.reset();
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── subscribe ─────────────────────────────────────────────────────────────────

describe('WsClient.subscribe', () => {
  it('opens a WebSocket on first subscribe and sends `subscribe` op once open', () => {
    const client = new WsClient('wss://x/realtime');

    client.subscribe('trade', vi.fn());

    expect(MockWebSocket.instances).toHaveLength(1);

    MockWebSocket.last!.open();

    expect(MockWebSocket.last!.sent).toContain(JSON.stringify({ op: 'subscribe', args: ['trade'] }));
  });

  it('reuses a single WS for multiple subscribes; sends subscribe op per new channel after open', () => {
    const client = new WsClient('wss://x/realtime');

    client.subscribe('trade', vi.fn());
    MockWebSocket.last!.open();

    /** Reset to make the next assertion easy. */
    MockWebSocket.last!.sent = [];

    client.subscribe('quote', vi.fn());

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.last!.sent).toEqual([JSON.stringify({ op: 'subscribe', args: ['quote'] })]);
  });

  it('dispatches messages to all subscribers of a table', () => {
    const client = new WsClient('wss://x/realtime');

    const a = vi.fn();
    const b = vi.fn();

    client.subscribe('trade', a);
    client.subscribe('trade', b);
    MockWebSocket.last!.open();

    MockWebSocket.last!.onmessage?.({
      data: JSON.stringify({ table: 'trade', action: 'insert', data: [{ price: 100 }] }),
    } as MessageEvent);

    expect(a).toHaveBeenCalledWith('insert', [{ price: 100 }]);
    expect(b).toHaveBeenCalledWith('insert', [{ price: 100 }]);
  });

  it('routes symbol-scoped subscribers (e.g. trade:XBTUSD) when data carries `symbol`', () => {
    const client = new WsClient('wss://x/realtime');

    const all  = vi.fn();
    const xbt  = vi.fn();
    const eth  = vi.fn();

    client.subscribe('trade',        all);
    client.subscribe('trade:XBTUSD', xbt);
    client.subscribe('trade:ETHUSD', eth);
    MockWebSocket.last!.open();

    MockWebSocket.last!.onmessage?.({
      data: JSON.stringify({
        table:  'trade',
        action: 'insert',
        data: [
          { symbol: 'XBTUSD', price: 100 },
          { symbol: 'ETHUSD', price: 200 },
          { symbol: 'XBTUSD', price: 101 },
        ],
      }),
    } as MessageEvent);

    expect(all).toHaveBeenCalledWith('insert', expect.arrayContaining([
      { symbol: 'XBTUSD', price: 100 },
      { symbol: 'ETHUSD', price: 200 },
    ]));

    expect(xbt).toHaveBeenCalledWith('insert', [
      { symbol: 'XBTUSD', price: 100 },
      { symbol: 'XBTUSD', price: 101 },
    ]);

    expect(eth).toHaveBeenCalledWith('insert', [{ symbol: 'ETHUSD', price: 200 }]);
  });
});

// ── unsubscribe (cleanup fn) ──────────────────────────────────────────────────

describe('WsClient unsubscribe', () => {
  it('sends `unsubscribe` op when the last listener for a channel is removed', () => {
    const client = new WsClient('wss://x/realtime');

    const unsub = client.subscribe('trade', vi.fn());
    MockWebSocket.last!.open();
    MockWebSocket.last!.sent = [];

    unsub();

    expect(MockWebSocket.last!.sent).toContain(JSON.stringify({ op: 'unsubscribe', args: ['trade'] }));
  });

  it('does NOT send `unsubscribe` while other listeners remain', () => {
    const client = new WsClient('wss://x/realtime');

    const unsubA = client.subscribe('trade', vi.fn());
    client.subscribe('trade', vi.fn());
    MockWebSocket.last!.open();
    MockWebSocket.last!.sent = [];

    unsubA();

    expect(MockWebSocket.last!.sent).toEqual([]);
  });
});

// ── destroy ───────────────────────────────────────────────────────────────────

describe('WsClient.destroy', () => {
  it('closes the underlying WebSocket', () => {
    const client = new WsClient('wss://x/realtime');

    client.subscribe('trade', vi.fn());
    MockWebSocket.last!.open();

    const ws = MockWebSocket.last!;

    client.destroy();

    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('is idempotent — calling destroy twice does not throw', () => {
    const client = new WsClient('wss://x/realtime');

    client.subscribe('trade', vi.fn());
    MockWebSocket.last!.open();

    expect(() => { client.destroy(); client.destroy(); }).not.toThrow();
  });

  it('allows reuse — a subscribe after destroy reopens a new WebSocket', () => {
    const client = new WsClient('wss://x/realtime');

    client.subscribe('trade', vi.fn());
    MockWebSocket.last!.open();
    client.destroy();

    /** Fresh subscribe after destroy must work (StrictMode-safe semantics). */
    client.subscribe('quote', vi.fn());

    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('does NOT reconnect via the listener-driven reconnect path after destroy when no listeners remain', () => {
    const client = new WsClient('wss://x/realtime');

    const unsub = client.subscribe('trade', vi.fn());
    MockWebSocket.last!.open();
    unsub();
    client.destroy();

    /** Advance past any reconnect delay; no new instance should pop up. */
    vi.advanceTimersByTime(60_000);

    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
