import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { connect } from '../src/websocket';
import type { State, Config, EndpointDefinition } from '../src/types';

// ── WebSocket mock ────────────────────────────────────────────────────────────

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');

  return {
    default: class MockWebSocket extends EventEmitter {
      static OPEN = 1;

      readyState = 1;
      url: string;
      send  = vi.fn();
      ping  = vi.fn();
      pong  = vi.fn();
      pause = vi.fn();
      resume = vi.fn();

      constructor(url: string) {
        super();
        this.url = url;
      }
    },
  };
});

// ── Service mock ──────────────────────────────────────────────────────────────

const makeService = (stateOverrides: Partial<State> = {}) => {
  const state: State = {
    realtime:        null,
    platform:        null,
    broker:          null,
    isShuttingDown:  false,
    lastMessageTime: 0,
    apiVersion:      null,
    ...stateOverrides,
  };

  const service = {
    state:    (key?: string) => (key !== undefined ? (state as Record<string, unknown>)[key] : state),
    setState: (key: string, value: unknown) => { (state as Record<string, unknown>)[key] = value; return value; },
    config:   () => ({}),
  };

  return { service, state };
};

const endpoint = (overrides: Partial<EndpointDefinition> = {}): EndpointDefinition => ({
  name: 'realtime',
  url:  'wss://www.bitmex.com/realtime',
  ...overrides,
});

const ws = (state: State, name: 'realtime' | 'platform'): any => state[name];

// ── URL construction ──────────────────────────────────────────────────────────

describe('URL construction', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uses the plain endpoint URL when no credentials are provided', () => {
    const { service } = makeService();

    const result = connect(endpoint(), service as any, vi.fn());

    expect(result.url).toBe('wss://www.bitmex.com/realtime');
  });

  it('appends auth query params when credentials are provided', () => {
    const { service } = makeService();
    const credentials = { apiKey: 'key-abc', expires: 1234567890, signature: 'sig-xyz' };

    const result = connect(endpoint(), service as any, vi.fn(), { credentials });

    expect(result.url).toBe(
      'wss://www.bitmex.com/realtime?api-key=key-abc&api-expires=1234567890&api-signature=sig-xyz',
    );
  });

  it('does not create a connection when the service is shutting down', () => {
    const { service } = makeService({ isShuttingDown: true });

    const result = connect(endpoint(), service as any, vi.fn());

    expect(result).toBeNull();
  });
});

// ── Open event ────────────────────────────────────────────────────────────────

describe('open event', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts a heartbeat interval on open', () => {
    const { service } = makeService();

    const result = connect(endpoint(), service as any, vi.fn());

    result.emit('open');

    vi.advanceTimersByTime(30_000);
    expect((result as any).ping).toHaveBeenCalledTimes(1);
  });

  it('updates lastMessageTime on open', () => {
    const { service, state } = makeService();
    const before = Date.now();

    const result = connect(endpoint(), service as any, vi.fn());

    result.emit('open');

    expect(state.lastMessageTime).toBeGreaterThanOrEqual(before);
  });
});

// ── Ping / message ────────────────────────────────────────────────────────────

describe('ping and message events', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('responds to ping with pong', () => {
    const { service } = makeService();

    const result = connect(endpoint(), service as any, vi.fn());

    result.emit('ping');

    expect((result as any).pong).toHaveBeenCalledOnce();
  });

  it('forwards received messages to the handler', () => {
    const { service } = makeService();
    const onMessage = vi.fn();

    const result = connect(endpoint(), service as any, onMessage);

    const payload = Buffer.from('{"table":"trade","action":"insert","data":[]}');

    result.emit('message', payload);

    expect(onMessage).toHaveBeenCalledWith(payload, undefined);
  });

  it('forwards accountId to the handler when set in options', () => {
    const { service } = makeService();
    const onMessage = vi.fn();

    const result = connect(endpoint(), service as any, onMessage, { accountId: 'acc-42' });

    const payload = Buffer.from('{"table":"trade","action":"insert","data":[]}');

    result.emit('message', payload);

    expect(onMessage).toHaveBeenCalledWith(payload, 'acc-42');
  });

  it('does not forward the connection pool to the handler (pool rides in the row content)', () => {
    const { service } = makeService();
    const onMessage = vi.fn();

    const result = connect(endpoint(), service as any, onMessage, { pool: 'Secondary' });

    const payload = Buffer.from('{"table":"orderBookL2","action":"insert","data":[]}');

    result.emit('message', payload);

    expect(onMessage).toHaveBeenCalledWith(payload, undefined);
  });
});

// ── Heartbeat ─────────────────────────────────────────────────────────────────

describe('heartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('pings the server every 30 seconds while the connection is open', () => {
    const { service } = makeService();

    const result = connect(endpoint(), service as any, vi.fn());

    result.emit('open');

    vi.advanceTimersByTime(30_000);
    expect((result as any).ping).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    expect((result as any).ping).toHaveBeenCalledTimes(2);
  });
});

// ── Reconnection ──────────────────────────────────────────────────────────────

describe('reconnection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('reconnects after a connection error', () => {
    const { service } = makeService();
    const onReconnect = vi.fn();

    const original = connect(endpoint(), service as any, vi.fn(), { onReconnect });

    original.emit('error', new Error('ECONNREFUSED'));

    vi.runAllTimers();

    expect(onReconnect).toHaveBeenCalledOnce();
    expect(onReconnect).not.toHaveBeenCalledWith(original);
  });

  it('reconnects after the connection closes', () => {
    const { service } = makeService();
    const onReconnect = vi.fn();

    const original = connect(endpoint(), service as any, vi.fn(), { onReconnect });

    original.emit('close', 1006, Buffer.from('abnormal'));

    vi.runAllTimers();

    expect(onReconnect).toHaveBeenCalledOnce();
    expect(onReconnect).not.toHaveBeenCalledWith(original);
  });

  it('does not reconnect after close when shutting down', () => {
    const { service, state } = makeService();
    const onReconnect = vi.fn();

    const original = connect(endpoint(), service as any, vi.fn(), { onReconnect });

    (state as any).isShuttingDown = true;

    original.emit('close', 1000, Buffer.from('normal'));

    vi.runAllTimers();

    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('clears the heartbeat interval when the connection closes', () => {
    const { service } = makeService();

    const result = connect(endpoint(), service as any, vi.fn());

    result.emit('open');

    // heartbeat running
    vi.advanceTimersByTime(30_000);
    expect((result as any).ping).toHaveBeenCalledTimes(1);

    result.emit('close', 1000, Buffer.from(''));

    // heartbeat should be cleared — no more pings
    vi.advanceTimersByTime(30_000);
    expect((result as any).ping).toHaveBeenCalledTimes(1);
  });

  it('schedules only one reconnect when error and close both fire', () => {
    const { service } = makeService();
    const onReconnect = vi.fn();

    const original = connect(endpoint(), service as any, vi.fn(), { onReconnect });

    // A real connection failure emits both events — they must collapse into one attempt.
    original.emit('error', new Error('ECONNREFUSED'));
    original.emit('close', 1006, Buffer.from('abnormal'));

    vi.runAllTimers();

    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it('jumps straight to the maximum backoff after a 429', () => {
    const { service } = makeService();
    const onReconnect = vi.fn();

    const original = connect(endpoint(), service as any, vi.fn(), { onReconnect });

    original.emit('error', new Error('Unexpected server response: 429'));

    // Normal first backoff is 200ms — a 429 must skip the ramp to the 15s cap.
    vi.advanceTimersByTime(14_999);
    expect(onReconnect).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onReconnect).toHaveBeenCalledOnce();
  });
});
