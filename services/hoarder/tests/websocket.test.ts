import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { logger } from '@devvir/service-kit';
import { connect } from '../src/websocket';
import type { State, Config, EndpointDefinition } from '../src/types';

// ── WebSocket mock ────────────────────────────────────────────────────────────

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');

  return {
    default: class MockWebSocket extends EventEmitter {
      static CONNECTING = 0;
      static OPEN       = 1;
      static CLOSING    = 2;
      static CLOSED     = 3;

      /** Every socket constructed, oldest first. */
      static instances: MockWebSocket[] = [];

      readyState = 1;
      isPaused   = false;
      url:     string;
      options: unknown;
      send   = vi.fn();
      ping   = vi.fn();
      pong   = vi.fn();
      pause  = vi.fn();
      resume = vi.fn();

      /** Like ws: the socket is destroyed and 'close' follows. */
      terminate = vi.fn(() => {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.emit('close', 1006, Buffer.alloc(0));
      });

      constructor(url: string, options?: unknown) {
        super();
        this.url     = url;
        this.options = options;
        MockWebSocket.instances.push(this);
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
  url:  'wss://twin.test/realtime',
  ...overrides,
});

const ws = (state: State, name: 'realtime' | 'platform'): any => state[name];

// ── URL construction ──────────────────────────────────────────────────────────

describe('URL construction', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uses the plain endpoint URL when no credentials are provided', () => {
    const { service } = makeService();

    const result = connect(endpoint(), 'twin', service as any, vi.fn());

    expect(result.url).toBe('wss://twin.test/realtime');
  });

  // Hoarder collects public market data only, so a URL is never decorated with
  // credentials — there is no authenticated connection path to build one.
  it('uses the endpoint URL verbatim for every socket', () => {
    const { service } = makeService();

    const result = connect(endpoint(), 'twin', service as any, vi.fn(), { socketKey: 'Primary' });

    expect(result.url).toBe('wss://twin.test/realtime');
  });

  it('does not create a connection when the service is shutting down', () => {
    const { service } = makeService({ isShuttingDown: true });

    const result = connect(endpoint(), 'twin', service as any, vi.fn());

    expect(result).toBeNull();
  });
});

// ── Open event ────────────────────────────────────────────────────────────────

describe('open event', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts a heartbeat interval on open', () => {
    const { service } = makeService();

    const result = connect(endpoint(), 'twin', service as any, vi.fn());

    result.emit('open');

    vi.advanceTimersByTime(30_000);
    expect((result as any).ping).toHaveBeenCalledTimes(1);
  });
});

// ── Ping / message ────────────────────────────────────────────────────────────

describe('ping and message events', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // ws answers every ping itself; a second, manual pong would double the
  // control frames a venue counts against its per-connection limit.
  it('leaves answering a ping to ws', () => {
    const { service } = makeService();

    const result = connect(endpoint(), 'twin', service as any, vi.fn());

    result.emit('open');
    result.emit('ping', Buffer.from('payload'));

    expect((result as any).pong).not.toHaveBeenCalled();
  });

  it('forwards received messages to the handler', () => {
    const { service } = makeService();
    const onMessage = vi.fn().mockResolvedValue(undefined);

    const result = connect(endpoint(), 'twin', service as any, onMessage);

    const payload = Buffer.from('{"table":"trade","action":"insert","data":[]}');

    result.emit('message', payload);

    expect(onMessage).toHaveBeenCalledWith(payload, 'twin');
  });

  // The relay looks the venue up by this tag to route the frame, so every
  // message must carry the exchange it arrived on — not the socket key.
  it('tags every frame with its venue', () => {
    const { service } = makeService();
    const onMessage = vi.fn().mockResolvedValue(undefined);

    const result = connect(endpoint(), 'binance', service as any, onMessage, { socketKey: 'shard-1' });

    const payload = Buffer.from('{"stream":"btcusdt@aggTrade"}');

    result.emit('message', payload);

    expect(onMessage).toHaveBeenCalledWith(payload, 'binance')
  });

  // A handler's rejection must not escape as an unhandled rejection, which
  // would end the process; vitest fails the run on one.
  it('logs a frame the handler fails on and keeps relaying', async () => {
    const { service } = makeService();
    const onMessage = vi.fn()
      .mockRejectedValueOnce(new Error('relay broke'))
      .mockResolvedValue(undefined);

    const result = connect(endpoint(), 'twin', service as any, onMessage) as any;

    result.emit('message', Buffer.from('{"a":1}'));
    result.emit('message', Buffer.from('{"a":2}'));

    await vi.advanceTimersByTimeAsync(0);

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ message: 'relay broke' }), venue: 'twin' }),
      'Relay failed',
    );
  });
});

// ── Heartbeat ─────────────────────────────────────────────────────────────────

describe('heartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('pings the server every 30 seconds while the connection is open', () => {
    const { service } = makeService();

    const result = connect(endpoint(), 'twin', service as any, vi.fn());

    result.emit('open');

    vi.advanceTimersByTime(30_000);
    expect((result as any).ping).toHaveBeenCalledTimes(1);

    result.emit('pong');

    vi.advanceTimersByTime(30_000);
    expect((result as any).ping).toHaveBeenCalledTimes(2);
  });
});

// ── Liveness ──────────────────────────────────────────────────────────────────

describe('liveness', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('bounds the opening handshake', () => {
    const { service } = makeService();

    const result = connect(endpoint(), 'twin', service as any, vi.fn());

    expect((result as any).options).toMatchObject({ handshakeTimeout: 10_000 });
  });

  it('terminates a socket that leaves a ping unanswered until the next one is due', () => {
    const { service } = makeService();

    const result = connect(endpoint(), 'twin', service as any, vi.fn()) as any;

    result.emit('open');

    vi.advanceTimersByTime(30_000);
    expect(result.terminate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);
    expect(result.terminate).toHaveBeenCalledOnce();
    expect(result.ping).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('did not answer a ping'));
  });

  it('keeps a socket that answers with a pong', () => {
    const { service } = makeService();

    const result = connect(endpoint(), 'twin', service as any, vi.fn()) as any;

    result.emit('open');

    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(30_000);
      result.emit('pong');
    }

    expect(result.terminate).not.toHaveBeenCalled();
    expect(result.ping).toHaveBeenCalledTimes(4);
  });

  it('counts any inbound frame as an answer', () => {
    const { service } = makeService();

    const result = connect(endpoint(), 'twin', service as any, vi.fn().mockResolvedValue(undefined)) as any;

    result.emit('open');

    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(30_000);
      result.emit('message', Buffer.from('{}'));
    }

    expect(result.terminate).not.toHaveBeenCalled();
  });

  it('neither pings nor judges a paused socket', () => {
    const { service } = makeService();

    const result = connect(endpoint(), 'twin', service as any, vi.fn()) as any;

    result.emit('open');

    vi.advanceTimersByTime(30_000);   // ping sent, no pong yet
    result.isPaused = true;

    vi.advanceTimersByTime(90_000);
    expect(result.ping).toHaveBeenCalledOnce();
    expect(result.terminate).not.toHaveBeenCalled();

    // Resumed: the deadline starts over, so one silent interval is not enough.
    result.isPaused = false;

    vi.advanceTimersByTime(30_000);
    expect(result.ping).toHaveBeenCalledTimes(2);
    expect(result.terminate).not.toHaveBeenCalled();
  });

  it('replaces a terminated socket exactly once', () => {
    const { service } = makeService();
    const onReconnect = vi.fn();

    const result = connect(endpoint(), 'twin', service as any, vi.fn(), { onReconnect }) as any;

    result.emit('open');
    vi.advanceTimersByTime(60_000);
    expect(result.terminate).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1_000);
    expect(onReconnect).toHaveBeenCalledOnce();
    expect(onReconnect).not.toHaveBeenCalledWith(result);
  });
});

// ── Reconnection ──────────────────────────────────────────────────────────────

describe('reconnection', () => {
  // Jitter at its midpoint, so every delay is the nominal one.
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('reconnects after a connection error', () => {
    const { service } = makeService();
    const onReconnect = vi.fn();

    const original = connect(endpoint(), 'twin', service as any, vi.fn(), { onReconnect });

    original.emit('error', new Error('ECONNREFUSED'));

    vi.runAllTimers();

    expect(onReconnect).toHaveBeenCalledOnce();
    expect(onReconnect).not.toHaveBeenCalledWith(original);
  });

  it('reconnects after the connection closes', () => {
    const { service } = makeService();
    const onReconnect = vi.fn();

    const original = connect(endpoint(), 'twin', service as any, vi.fn(), { onReconnect });

    original.emit('close', 1006, Buffer.from('abnormal'));

    vi.runAllTimers();

    expect(onReconnect).toHaveBeenCalledOnce();
    expect(onReconnect).not.toHaveBeenCalledWith(original);
  });

  it('makes no socket once its signal is aborted', () => {
    const { service } = makeService();
    const stop = new AbortController();

    stop.abort();

    expect(connect(endpoint(), 'twin', service as any, vi.fn(), { signal: stop.signal })).toBeNull();
  });

  it('cancels a pending reconnect when its signal is aborted', () => {
    const { service } = makeService();
    const onReconnect = vi.fn();
    const stop = new AbortController();

    const original = connect(endpoint(), 'twin', service as any, vi.fn(), { onReconnect, signal: stop.signal })!;
    const count    = (WebSocket as any).instances.length;

    original.emit('close', 1006, Buffer.alloc(0));
    expect(vi.getTimerCount()).toBe(1);

    stop.abort();
    expect(vi.getTimerCount()).toBe(0);

    vi.runAllTimers();

    expect(onReconnect).not.toHaveBeenCalled();
    expect((WebSocket as any).instances.length).toBe(count);
  });

  // Sockets closed by a shutdown are expected to close: no warning, no reconnect.
  it('neither warns about nor replaces a socket that closes after its signal is aborted', () => {
    const { service } = makeService();
    const onReconnect = vi.fn();
    const stop = new AbortController();

    const original = connect(endpoint(), 'twin', service as any, vi.fn(), { onReconnect, signal: stop.signal }) as any;

    original.emit('open');
    stop.abort();
    vi.mocked(logger.warn).mockClear();
    original.terminate();

    vi.runAllTimers();

    expect(onReconnect).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not reconnect after close when shutting down', () => {
    const { service, state } = makeService();
    const onReconnect = vi.fn();

    const original = connect(endpoint(), 'twin', service as any, vi.fn(), { onReconnect });

    (state as any).isShuttingDown = true;

    original.emit('close', 1000, Buffer.from('normal'));

    vi.runAllTimers();

    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('clears the heartbeat interval when the connection closes', () => {
    const { service } = makeService();

    const result = connect(endpoint(), 'twin', service as any, vi.fn());

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

    const original = connect(endpoint(), 'twin', service as any, vi.fn(), { onReconnect });

    // A real connection failure emits both events — they must collapse into one attempt.
    original.emit('error', new Error('ECONNREFUSED'));
    original.emit('close', 1006, Buffer.from('abnormal'));

    vi.runAllTimers();

    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it('jumps straight to the maximum backoff after a 429', () => {
    const { service } = makeService();
    const onReconnect = vi.fn();

    const original = connect(endpoint(), 'twin', service as any, vi.fn(), { onReconnect });

    original.emit('error', new Error('Unexpected server response: 429'));

    // Normal first backoff is 200ms — a 429 must skip the ramp to the 15s cap.
    vi.advanceTimersByTime(14_999);
    expect(onReconnect).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it('opens one replacement when a late close follows an error on an open socket', () => {
    const { service } = makeService();
    const onReconnect = vi.fn();

    const original = connect(endpoint(), 'twin', service as any, vi.fn(), { onReconnect }) as any;

    original.emit('open');
    original.emit('error', new Error('Invalid WebSocket frame: invalid opcode 5'));

    expect(original.terminate).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(200);
    expect(onReconnect).toHaveBeenCalledOnce();

    // ws delivers the original's close late, after its replacement exists.
    original.emit('close', 1002, Buffer.from(''));

    vi.advanceTimersByTime(1_000);
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it('waits for the close of a socket that fails while connecting', () => {
    const { service } = makeService();
    const onReconnect = vi.fn();

    const original = connect(endpoint(), 'twin', service as any, vi.fn(), { onReconnect }) as any;

    original.readyState = WebSocket.CONNECTING;
    original.emit('error', new Error('Unexpected server response: 503'));

    vi.advanceTimersByTime(1_000);
    expect(onReconnect).not.toHaveBeenCalled();

    original.readyState = WebSocket.CLOSED;
    original.emit('close', 1006, Buffer.from(''));

    vi.advanceTimersByTime(200);
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it('ignores the close of a socket that has been replaced', () => {
    const { service } = makeService();
    const onReconnect = vi.fn();

    const original = connect(endpoint(), 'twin', service as any, vi.fn(), { onReconnect }) as any;

    original.emit('close', 1006, Buffer.from(''));
    vi.advanceTimersByTime(200);

    const replacement = onReconnect.mock.calls[0][0];

    original.emit('close', 1006, Buffer.from(''));
    vi.advanceTimersByTime(20_000);

    expect(onReconnect).toHaveBeenCalledOnce();

    replacement.emit('close', 1006, Buffer.from(''));
    vi.advanceTimersByTime(20_000);

    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  /** Drive one accept-then-close cycle and return how long its replacement took. */
  const cycle = (socket: any, onReconnect: ReturnType<typeof vi.fn>, openFor = 0): number => {
    const calls = onReconnect.mock.calls.length;

    socket.emit('open');
    vi.advanceTimersByTime(openFor);
    socket.emit('close', 1008, Buffer.from('policy'));

    let waited = 0;
    while (onReconnect.mock.calls.length === calls) { vi.advanceTimersByTime(100); waited += 100; }

    return waited;
  };

  it('keeps backing off while sockets open and close at once', () => {
    const { service } = makeService();
    const onReconnect = vi.fn();

    let socket: any = connect(endpoint(), 'twin', service as any, vi.fn(), { onReconnect });

    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      delays.push(cycle(socket, onReconnect));
      socket = onReconnect.mock.calls.at(-1)![0];
    }

    expect(delays).toEqual([200, 400, 800, 1_600, 3_200, 6_400, 12_800, 15_000, 15_000]);
  });

  it('starts the backoff over once a socket has stayed open for 30 seconds', () => {
    const { service } = makeService();
    const onReconnect = vi.fn();

    let socket: any = connect(endpoint(), 'twin', service as any, vi.fn(), { onReconnect });

    for (let i = 0; i < 4; i++) {
      cycle(socket, onReconnect, 29_000);
      socket = onReconnect.mock.calls.at(-1)![0];
    }

    // Open 29 s each time: never stable, so the delay is now 3.2 s.
    expect(cycle(socket, onReconnect, 30_000)).toBe(200);
  });

  it('spreads the delay by up to 20 percent, never past the cap', () => {
    const { service } = makeService();
    const onReconnect = vi.fn();

    vi.mocked(Math.random).mockReturnValue(0.999);

    const low = connect(endpoint(), 'twin', service as any, vi.fn(), { onReconnect }) as any;
    low.emit('close', 1006, Buffer.from(''));

    vi.advanceTimersByTime(239);
    expect(onReconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onReconnect).toHaveBeenCalledOnce();

    const capped = connect(endpoint(), 'twin', service as any, vi.fn(), { onReconnect }) as any;
    capped.emit('error', new Error('Unexpected server response: 429'));

    vi.advanceTimersByTime(15_000);
    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  it('treats HTTP 418 as a rate limit too', () => {
    const { service } = makeService();
    const onReconnect = vi.fn();

    const original = connect(endpoint(), 'twin', service as any, vi.fn(), { onReconnect });

    original.emit('error', new Error('Unexpected server response: 418'));

    vi.advanceTimersByTime(14_999);
    expect(onReconnect).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onReconnect).toHaveBeenCalledOnce();
  });
});
