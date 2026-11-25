import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WsClient } from '../../src/data/WsClient';

// ── MockWebSocket ─────────────────────────────────────────────────────────────

/**
 * WebSocket double with the browser's lifecycle ordering: a new socket is
 * CONNECTING until the test calls `open()`, and `close()` moves to CLOSING and
 * fires `onclose` on a later task (a 0 ms timer — fake timers are on), never
 * synchronously. `serverClose()`, `error()` and `message()` deliver the
 * corresponding events through the handler properties, as a browser does.
 */
class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN       = 1;
  static readonly CLOSING    = 2;
  static readonly CLOSED     = 3;

  /** Latest instance — convenient for tests that only open one connection. */
  static last: MockWebSocket | null = null;

  /** Every instance created, in construction order. */
  static instances: MockWebSocket[] = [];

  static reset() {
    MockWebSocket.last = null;
    MockWebSocket.instances = [];
  }

  readyState: number = MockWebSocket.CONNECTING;
  sent:       string[] = [];

  onopen:    (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose:   (() => void) | null = null;
  onerror:   (() => void) | null = null;

  constructor(public readonly url: string) {
    MockWebSocket.last = this;
    MockWebSocket.instances.push(this);
  }

  /** The handshake completes. */
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === MockWebSocket.CLOSING || this.readyState === MockWebSocket.CLOSED) {
      return;
    }

    this.readyState = MockWebSocket.CLOSING;

    setTimeout(() => {
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.();
    }, 0);
  }

  /** The server (or the network) closes the connection. */
  serverClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  /** The socket reports an error; a browser follows it with a close. */
  error() {
    this.onerror?.();
  }

  /** A frame arrives; non-strings are JSON-encoded. */
  message(frame: unknown) {
    const data = typeof frame === 'string' ? frame : JSON.stringify(frame);

    this.onmessage?.({ data } as MessageEvent);
  }

  get alive() {
    return this.readyState === MockWebSocket.CONNECTING || this.readyState === MockWebSocket.OPEN;
  }
}

const subscribeOp   = (...args: string[]) => JSON.stringify({ op: 'subscribe',   args });
const unsubscribeOp = (...args: string[]) => JSON.stringify({ op: 'unsubscribe', args });
const tradeFrame    = { table: 'trade', action: 'insert', data: [{ price: 100 }] };

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
    expect(MockWebSocket.last!.sent).toEqual([]);

    MockWebSocket.last!.open();

    expect(MockWebSocket.last!.sent).toEqual([subscribeOp('trade')]);
  });

  it('sends one `subscribe` op for every channel registered before the socket opens', () => {
    const client = new WsClient('wss://x/realtime');

    client.subscribe('trade', vi.fn());
    client.subscribe('quote', vi.fn());

    expect(MockWebSocket.instances).toHaveLength(1);

    MockWebSocket.last!.open();

    expect(MockWebSocket.last!.sent).toEqual([subscribeOp('trade', 'quote')]);
  });

  it('reuses a single WS for multiple subscribes; sends subscribe op per new channel after open', () => {
    const client = new WsClient('wss://x/realtime');

    client.subscribe('trade', vi.fn());
    MockWebSocket.last!.open();

    /** Reset to make the next assertion easy. */
    MockWebSocket.last!.sent = [];

    client.subscribe('quote', vi.fn());

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.last!.sent).toEqual([subscribeOp('quote')]);
  });

  it('does not send a second `subscribe` op when another listener joins an already-subscribed channel', () => {
    const client = new WsClient('wss://x/realtime');
    const a      = vi.fn();
    const b      = vi.fn();

    client.subscribe('trade:XBTUSD', a);
    MockWebSocket.last!.open();
    client.subscribe('trade:XBTUSD', b);

    expect(MockWebSocket.last!.sent).toEqual([subscribeOp('trade:XBTUSD')]);

    MockWebSocket.last!.message({ table: 'trade', action: 'insert', data: [{ symbol: 'XBTUSD', price: 1 }] });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('dispatches messages to all subscribers of a table', () => {
    const client = new WsClient('wss://x/realtime');

    const a = vi.fn();
    const b = vi.fn();

    client.subscribe('trade', a);
    client.subscribe('trade', b);
    MockWebSocket.last!.open();

    MockWebSocket.last!.message(tradeFrame);

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

    MockWebSocket.last!.message({
      table:  'trade',
      action: 'insert',
      data: [
        { symbol: 'XBTUSD', price: 100 },
        { symbol: 'ETHUSD', price: 200 },
        { symbol: 'XBTUSD', price: 101 },
      ],
    });

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

  it('delivers a frame without `symbol` to table-level subscribers only', () => {
    const client = new WsClient('wss://x/realtime');
    const all    = vi.fn();
    const xbt    = vi.fn();

    client.subscribe('trade',        all);
    client.subscribe('trade:XBTUSD', xbt);
    MockWebSocket.last!.open();

    MockWebSocket.last!.message(tradeFrame);

    expect(all).toHaveBeenCalledTimes(1);
    expect(xbt).not.toHaveBeenCalled();
  });

  it('ignores malformed JSON and frames that are not table data', () => {
    const client  = new WsClient('wss://x/realtime');
    const handler = vi.fn();

    client.subscribe('trade', handler);
    MockWebSocket.last!.open();

    const ws = MockWebSocket.last!;

    expect(() => ws.message('{not json')).not.toThrow();
    ws.message({ info: 'Welcome to the BitMEX Realtime API.' });
    ws.message({ success: true, subscribe: 'trade' });
    ws.message({ table: 'trade', action: 'insert' });

    expect(handler).not.toHaveBeenCalled();
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

    expect(MockWebSocket.last!.sent).toEqual([unsubscribeOp('trade')]);
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

// ── reconnect ─────────────────────────────────────────────────────────────────

describe('WsClient reconnect', () => {
  it('backs off 1 s, 2 s, 4 s … capped at 30 s between failed connections', () => {
    const client = new WsClient('wss://x/realtime');

    client.subscribe('trade', vi.fn());
    MockWebSocket.last!.open();

    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const count = MockWebSocket.instances.length;

      MockWebSocket.last!.serverClose();

      vi.advanceTimersByTime(delay - 1);
      expect(MockWebSocket.instances).toHaveLength(count);

      vi.advanceTimersByTime(1);
      expect(MockWebSocket.instances).toHaveLength(count + 1);
    }
  });

  it('resets the backoff to 1 s once a connection opens', () => {
    const client = new WsClient('wss://x/realtime');

    client.subscribe('trade', vi.fn());
    MockWebSocket.last!.open();

    MockWebSocket.last!.serverClose();
    vi.advanceTimersByTime(1_000);
    MockWebSocket.last!.serverClose();
    vi.advanceTimersByTime(2_000);

    expect(MockWebSocket.instances).toHaveLength(3);

    MockWebSocket.last!.open();
    MockWebSocket.last!.serverClose();

    vi.advanceTimersByTime(1_000);
    expect(MockWebSocket.instances).toHaveLength(4);
  });

  it('subscribes every registered channel in one op after reconnecting', () => {
    const client = new WsClient('wss://x/realtime');

    client.subscribe('trade', vi.fn());
    client.subscribe('quote', vi.fn());
    MockWebSocket.last!.open();
    MockWebSocket.last!.serverClose();

    vi.advanceTimersByTime(1_000);
    MockWebSocket.last!.open();

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.last!.sent).toEqual([subscribeOp('trade', 'quote')]);
  });

  it('closes the socket on error and reconnects after the backoff', () => {
    const client = new WsClient('wss://x/realtime');

    client.subscribe('trade', vi.fn());

    const first = MockWebSocket.last!;

    first.error();
    vi.advanceTimersByTime(0);

    expect(first.readyState).toBe(MockWebSocket.CLOSED);
    expect(MockWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(1_000);

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.last!.alive).toBe(true);
  });

  it('does not reconnect when the last listener leaves during the backoff', () => {
    const client = new WsClient('wss://x/realtime');

    const unsub = client.subscribe('trade', vi.fn());
    MockWebSocket.last!.open();
    MockWebSocket.last!.serverClose();
    unsub();

    vi.advanceTimersByTime(60_000);

    expect(MockWebSocket.instances).toHaveLength(1);
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
    vi.advanceTimersByTime(0);

    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('is idempotent — calling destroy twice does not throw', () => {
    const client = new WsClient('wss://x/realtime');

    client.subscribe('trade', vi.fn());
    MockWebSocket.last!.open();

    expect(() => { client.destroy(); client.destroy(); }).not.toThrow();
  });

  it('allows reuse — a subscribe after destroy opens a new WebSocket that subscribes every channel', () => {
    const client = new WsClient('wss://x/realtime');

    client.subscribe('trade', vi.fn());
    MockWebSocket.last!.open();
    client.destroy();

    client.subscribe('quote', vi.fn());

    expect(MockWebSocket.instances).toHaveLength(2);

    MockWebSocket.last!.open();

    expect(MockWebSocket.last!.sent).toEqual([subscribeOp('trade', 'quote')]);
  });

  it('does NOT reconnect after destroy when no listeners remain', () => {
    const client = new WsClient('wss://x/realtime');

    const unsub = client.subscribe('trade', vi.fn());
    MockWebSocket.last!.open();
    unsub();
    client.destroy();

    vi.advanceTimersByTime(60_000);

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('does NOT reconnect after destroy while listeners remain', () => {
    const client = new WsClient('wss://x/realtime');

    client.subscribe('trade', vi.fn());
    MockWebSocket.last!.open();
    client.destroy();

    vi.advanceTimersByTime(60_000);

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('cancels a reconnect pending at destroy, before or after the listeners leave', () => {
    for (const unsubFirst of [true, false]) {
      MockWebSocket.reset();

      const client = new WsClient('wss://x/realtime');
      const unsub  = client.subscribe('trade', vi.fn());

      MockWebSocket.last!.open();
      MockWebSocket.last!.serverClose();

      if (unsubFirst) {
        unsub();
        client.destroy();
      } else {
        client.destroy();
        unsub();
      }

      vi.advanceTimersByTime(60_000);

      expect(MockWebSocket.instances).toHaveLength(1);
    }
  });

  it('survives a destroy-then-reuse cycle while the first socket is still connecting', () => {
    for (const destroyFirst of [true, false]) {
      MockWebSocket.reset();

      /** The mount → unmount → remount sequence of an effect re-run that keeps the client. */
      const client  = new WsClient('wss://x/realtime');
      const handler = vi.fn();
      const unsub   = client.subscribe('trade', handler);

      if (destroyFirst) {
        client.destroy();
        unsub();
      } else {
        unsub();
        client.destroy();
      }

      client.subscribe('trade', handler);
      vi.advanceTimersByTime(0);

      expect(MockWebSocket.instances).toHaveLength(2);

      const [first, second] = MockWebSocket.instances;

      expect(first.readyState).toBe(MockWebSocket.CLOSED);
      expect(second.alive).toBe(true);

      second.open();
      vi.advanceTimersByTime(60_000);

      expect(MockWebSocket.instances).toHaveLength(2);
      expect(second.readyState).toBe(MockWebSocket.OPEN);
      expect(second.sent).toEqual([subscribeOp('trade')]);

      second.message(tradeFrame);

      expect(handler).toHaveBeenCalledTimes(1);
    }
  });

  it('ignores events from a socket it no longer owns', () => {
    const client  = new WsClient('wss://x/realtime');
    const handler = vi.fn();

    client.subscribe('trade', handler);

    const first = MockWebSocket.last!;

    first.open();

    /** Handlers captured before destroy stand in for events already queued on the old socket. */
    const stale = {
      onopen:    first.onopen!,
      onmessage: first.onmessage!,
      onclose:   first.onclose!,
      onerror:   first.onerror!,
    };

    client.destroy();
    client.subscribe('trade', handler);

    const second = MockWebSocket.last!;

    second.open();

    first.message(tradeFrame);
    stale.onmessage({ data: JSON.stringify(tradeFrame) } as MessageEvent);
    stale.onerror();
    stale.onclose();
    stale.onopen();
    vi.advanceTimersByTime(60_000);

    expect(handler).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(second.readyState).toBe(MockWebSocket.OPEN);
    expect(second.sent).toEqual([subscribeOp('trade')]);

    second.message(tradeFrame);

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
