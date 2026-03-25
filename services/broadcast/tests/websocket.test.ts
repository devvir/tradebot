import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import makeConnection from '../src/websocket';
import type { State, Config } from '../src/types';

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

const makeService = (stateOverrides: Partial<State> = {}, configOverrides: Partial<Config> = {}) => {
  const state: State = {
    realtime:        null,
    platform:        null,
    broker:          null,
    isShuttingDown:  false,
    lastMessageTime: 0,
    apiVersion:      null,
    pingInterval:    null,
    ...stateOverrides,
  };

  const config: Config = {
    env:              'live',
    workerUuid:       'test-uuid',
    rabbitmqUrl:      'amqp://localhost',
    realtimeWsUrl:    'wss://www.bitmex.com/realtime',
    platformWsUrl:    'wss://www.bitmex.com/realtimePlatform',
    realtimeChannels: ['trade', 'quote'],
    platformChannels: ['announcement', 'chat'],
    ...configOverrides,
  };

  const service = {
    state:    (key?: string) => (key !== undefined ? (state as Record<string, unknown>)[key] : state),
    setState: (key: string, value: unknown) => { (state as Record<string, unknown>)[key] = value; return value; },
    config:   () => config,
  };

  return { service, state, config };
};

const ws = (state: State, name: 'realtime' | 'platform'): any => state[name];

// ── Connection creation ───────────────────────────────────────────────────────

describe('connection creation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('connectRealtime uses the realtime URL from config', () => {
    const { service, state, config } = makeService();

    makeConnection(service as any, vi.fn()).connectRealtime();

    expect(ws(state, 'realtime')?.url).toBe(config.realtimeWsUrl);
  });

  it('connectPlatform uses the platform URL from config', () => {
    const { service, state, config } = makeService();

    makeConnection(service as any, vi.fn()).connectPlatform();

    expect(ws(state, 'platform')?.url).toBe(config.platformWsUrl);
  });

  it('does not create a connection when the service is shutting down', () => {
    const { service, state } = makeService({ isShuttingDown: true });

    makeConnection(service as any, vi.fn()).connectRealtime();

    expect(state.realtime).toBeNull();
  });
});

// ── Open event ────────────────────────────────────────────────────────────────

describe('open event', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends a subscribe message for configured channels on open', () => {
    const { service, state, config } = makeService();

    makeConnection(service as any, vi.fn()).connectRealtime();

    ws(state, 'realtime').emit('open');

    expect(ws(state, 'realtime').send).toHaveBeenCalledOnce();

    const sent = JSON.parse(ws(state, 'realtime').send.mock.calls[0][0]);

    expect(sent.op).toBe('subscribe');
    expect(sent.args).toEqual([...config.realtimeChannels]);
  });

  it('does not send subscribe when channels list is empty', () => {
    const { service, state } = makeService({}, { realtimeChannels: [] });

    makeConnection(service as any, vi.fn()).connectRealtime();

    ws(state, 'realtime').emit('open');

    expect(ws(state, 'realtime').send).not.toHaveBeenCalled();
  });

  it('starts a heartbeat interval on open', () => {
    const { service, state } = makeService();

    makeConnection(service as any, vi.fn()).connectRealtime();

    ws(state, 'realtime').emit('open');

    expect(state.pingInterval).not.toBeNull();
  });

  it('updates lastMessageTime on open', () => {
    const { service, state } = makeService();
    const before = Date.now();

    makeConnection(service as any, vi.fn()).connectRealtime();

    ws(state, 'realtime').emit('open');

    expect(state.lastMessageTime).toBeGreaterThanOrEqual(before);
  });
});

// ── Ping / message ────────────────────────────────────────────────────────────

describe('ping and message events', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('responds to ping with pong', () => {
    const { service, state } = makeService();

    makeConnection(service as any, vi.fn()).connectRealtime();

    ws(state, 'realtime').emit('ping');

    expect(ws(state, 'realtime').pong).toHaveBeenCalledOnce();
  });

  it('forwards received messages to the handler', () => {
    const { service, state } = makeService();
    const onMessage = vi.fn();

    makeConnection(service as any, onMessage).connectRealtime();

    const payload = Buffer.from('{"table":"trade","action":"insert","data":[]}');

    ws(state, 'realtime').emit('message', payload);

    expect(onMessage).toHaveBeenCalledWith(payload);
  });
});

// ── Heartbeat ─────────────────────────────────────────────────────────────────

describe('heartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('pings the server every 30 seconds while the connection is open', () => {
    const { service, state } = makeService();

    makeConnection(service as any, vi.fn()).connectRealtime();

    ws(state, 'realtime').emit('open');

    vi.advanceTimersByTime(30_000);
    expect(ws(state, 'realtime').ping).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    expect(ws(state, 'realtime').ping).toHaveBeenCalledTimes(2);
  });
});

// ── Reconnection ──────────────────────────────────────────────────────────────

describe('reconnection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('reconnects after a connection error', () => {
    const { service, state } = makeService();

    makeConnection(service as any, vi.fn()).connectRealtime();

    const original = ws(state, 'realtime');

    original.emit('error', new Error('ECONNREFUSED'));

    vi.runAllTimers();

    expect(state.realtime).not.toBe(original);
  });

  it('reconnects after the connection closes', () => {
    const { service, state } = makeService();

    makeConnection(service as any, vi.fn()).connectRealtime();

    const original = ws(state, 'realtime');

    original.emit('close', 1006, Buffer.from('abnormal'));

    vi.runAllTimers();

    expect(state.realtime).not.toBe(original);
  });

  it('does not reconnect after close when shutting down', () => {
    const { service, state } = makeService();

    makeConnection(service as any, vi.fn()).connectRealtime();

    const original = ws(state, 'realtime');

    (state as any).isShuttingDown = true;

    original.emit('close', 1000, Buffer.from('normal'));

    vi.runAllTimers();

    expect(state.realtime).toBe(original);
  });

  it('clears the heartbeat interval when the connection closes', () => {
    const { service, state } = makeService();

    makeConnection(service as any, vi.fn()).connectRealtime();

    ws(state, 'realtime').emit('open');

    expect(state.pingInterval).not.toBeNull();

    ws(state, 'realtime').emit('close', 1000, Buffer.from(''));

    expect(state.pingInterval).toBeNull();
  });
});
