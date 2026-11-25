import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '@devvir/service-kit';
import {
  createBackpressureGate, BACKPRESSURE_POLL_MS, PAUSED_POLL_MS, MISSING_QUEUE_WARN_MS,
} from '../src/backpressure';
import type { Config } from '../src/types';

vi.mock('@devvir/service-kit', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** An amqplib-like channel whose checkQueue answers from `depths`, with a 404 for a missing queue. */
const makeDepthChannel = (depths: Map<string, number>) => {
  const channel = Object.assign(new EventEmitter(), {
    checkQueue: vi.fn(async (name: string) => {
      if (depths.has(name)) return { queue: name, messageCount: depths.get(name)!, consumerCount: 0 };

      // As amqplib does: the server closes the channel, which emits 'error' then 'close', and the
      // pending call rejects with the reply code.
      const err = Object.assign(new Error(`Operation failed: QueueDeclare; 404 (NOT-FOUND) no queue '${name}'`), { code: 404 });

      channel.emit('error', err);
      channel.emit('close');
      throw err;
    }),
    close: vi.fn(async () => { channel.emit('close'); }),
  });

  return channel;
};

/** A consumer broker: its own channel must stay untouched; depth channels come from its connection. */
const makeBroker = (depths: Map<string, number>) => {
  const brokerChannel = { checkQueue: vi.fn(), close: vi.fn() };
  const depthChannels: ReturnType<typeof makeDepthChannel>[] = [];

  const connection = {
    createChannel: vi.fn(async () => {
      const ch = makeDepthChannel(depths);
      depthChannels.push(ch);
      return ch;
    }),
  };

  const broker = {
    getChannel:    vi.fn(() => brokerChannel),
    getConnection: vi.fn(() => connection as unknown),
  };

  /** Every checkQueue call on any depth channel, as queue names. */
  const checks = () => depthChannels.flatMap((ch) => ch.checkQueue.mock.calls.map(([name]) => name));

  return { broker, brokerChannel, connection, depthChannels, checks };
};

const config = (watchQueues: string[], maxReady = 100): Config => ({
  rabbitmqUrl: '',
  routes:      [],
  prefetch:    500,
  maxReady,
  watchQueues,
  maxAttempts:        5,
  deadLetterExchange: 'dead',
  deadLetterQueue:    'dead.q',
});

/** Whether a promise has settled, after letting pending microtasks run. */
const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false;

  void promise.then(() => { done = true; }, () => { done = true; });
  await vi.advanceTimersByTimeAsync(0);

  return done;
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createBackpressureGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['maxReady is 0', config(['q'], 0)],
    ['maxReady is negative', config(['q'], -1)],
    ['no queue is watched', config([], 100)],
  ])('is null when %s', async (_, cfg) => {
    const { broker, connection } = makeBroker(new Map());

    await expect(createBackpressureGate(broker as any, cfg)).resolves.toBeNull();
    expect(connection.createChannel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes through while every watched queue is below the limit', async () => {
    const { broker } = makeBroker(new Map([['a', 99], ['b', 0]]));
    const gate       = (await createBackpressureGate(broker as any, config(['a', 'b'])))!;

    expect(await settled(gate.hold())).toBe(true);

    await gate.stop();
  });

  it('reads the depths before it is returned', async () => {
    const { broker } = makeBroker(new Map([['a', 100]]));
    const gate       = (await createBackpressureGate(broker as any, config(['a'])))!;

    expect(await settled(gate.hold())).toBe(false);

    await gate.stop();
  });

  it('is at capacity while a watched queue is at the limit, by the depths last read', async () => {
    const depths     = new Map([['a', 0], ['b', 100]]);
    const { broker } = makeBroker(depths);
    const gate       = (await createBackpressureGate(broker as any, config(['a', 'b'])))!;

    expect(gate.atCapacity()).toBe(true);

    depths.set('b', 99);
    expect(gate.atCapacity()).toBe(true);

    await vi.advanceTimersByTimeAsync(BACKPRESSURE_POLL_MS);
    expect(gate.atCapacity()).toBe(false);

    await gate.stop();
  });

  it('holds while a queue is at the limit, and releases once it drops below', async () => {
    const depths     = new Map([['a', 100]]);
    const { broker } = makeBroker(depths);
    const gate       = (await createBackpressureGate(broker as any, config(['a'])))!;

    const held = gate.hold();

    await vi.advanceTimersByTimeAsync(PAUSED_POLL_MS * 3);
    expect(await settled(held)).toBe(false);

    depths.set('a', 99);
    await vi.advanceTimersByTimeAsync(PAUSED_POLL_MS);
    expect(await settled(held)).toBe(true);

    await gate.stop();
  });

  it('releases concurrent callers together, through one shared wait', async () => {
    const depths             = new Map([['a', 500]]);
    const { broker, checks } = makeBroker(depths);
    const gate               = (await createBackpressureGate(broker as any, config(['a'])))!;

    const held = [gate.hold(), gate.hold(), gate.hold()];

    await vi.advanceTimersByTimeAsync(PAUSED_POLL_MS);

    // One read for the priming poll and one for the single shared wait, not one per caller.
    expect(checks()).toHaveLength(2);

    depths.set('a', 0);
    await vi.advanceTimersByTimeAsync(PAUSED_POLL_MS);

    expect(await Promise.all(held.map(settled))).toEqual([true, true, true]);

    await gate.stop();
  });

  it('keeps holding while another watched queue is still full', async () => {
    const depths     = new Map([['a', 100], ['b', 100]]);
    const { broker } = makeBroker(depths);
    const gate       = (await createBackpressureGate(broker as any, config(['a', 'b'])))!;

    const held = gate.hold();

    depths.set('a', 0);
    await vi.advanceTimersByTimeAsync(PAUSED_POLL_MS * 5);
    expect(await settled(held)).toBe(false);

    depths.set('b', 0);
    await vi.advanceTimersByTimeAsync(PAUSED_POLL_MS * 2);
    expect(await settled(held)).toBe(true);

    await gate.stop();
  });

  it('is not wedged by a failed read while it holds', async () => {
    const depths                    = new Map([['a', 100]]);
    const { broker, depthChannels } = makeBroker(depths);
    const gate                      = (await createBackpressureGate(broker as any, config(['a'])))!;

    depthChannels[0].checkQueue.mockRejectedValueOnce(new Error('timeout'));

    const held = gate.hold();

    await vi.advanceTimersByTimeAsync(PAUSED_POLL_MS);
    expect(await settled(held)).toBe(false);

    depths.set('a', 0);
    await vi.advanceTimersByTimeAsync(PAUSED_POLL_MS);
    await expect(held).resolves.toBeUndefined();

    expect(await settled(gate.hold())).toBe(true);

    await gate.stop();
  });

  it('logs a failed background read instead of rejecting, and keeps the last depth', async () => {
    const unhandled = vi.fn();

    process.on('unhandledRejection', unhandled);

    try {
      const depths                    = new Map([['a', 100]]);
      const { broker, depthChannels } = makeBroker(depths);
      const gate                      = (await createBackpressureGate(broker as any, config(['a'])))!;

      depthChannels[0].checkQueue.mockRejectedValue(new Error('timeout'));

      await vi.advanceTimersByTimeAsync(BACKPRESSURE_POLL_MS * 3);
      await new Promise((resolve) => process.nextTick(resolve));

      expect(unhandled).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ queue: 'a', err: expect.objectContaining({ message: 'timeout' }) }),
        expect.stringContaining('Could not read the queue depth'),
      );
      expect(await settled(gate.hold())).toBe(false);

      await gate.stop();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('skips a background read while the previous one is still running', async () => {
    const { broker, depthChannels, checks } = makeBroker(new Map([['a', 0]]));
    const gate                              = (await createBackpressureGate(broker as any, config(['a'])))!;

    depthChannels[0].checkQueue.mockImplementation(() => new Promise(() => {}));

    await vi.advanceTimersByTimeAsync(BACKPRESSURE_POLL_MS * 4);

    // The priming poll and the first background poll, which never finishes.
    expect(checks()).toHaveLength(2);

    await gate.stop();
  });

  // ── Depth channel ───────────────────────────────────────────────────────────

  it('counts a missing queue as depth 0 without touching the broker channel', async () => {
    const { broker, brokerChannel } = makeBroker(new Map());
    const gate                      = (await createBackpressureGate(broker as any, config(['missing'], 1)))!;

    expect(await settled(gate.hold())).toBe(true);
    expect(broker.getChannel).not.toHaveBeenCalled();
    expect(brokerChannel.checkQueue).not.toHaveBeenCalled();

    await gate.stop();
  });

  it('opens a new depth channel on the next read after a missing queue closes it', async () => {
    const { broker, connection, checks } = makeBroker(new Map([['a', 5]]));
    const gate                           = (await createBackpressureGate(broker as any, config(['missing', 'a'])))!;

    expect(connection.createChannel).toHaveBeenCalledTimes(2);
    expect(checks()).toEqual(['missing', 'a']);

    await vi.advanceTimersByTimeAsync(BACKPRESSURE_POLL_MS);

    // The channel 'a' was read on serves 'missing', which closes it; 'a' gets a new one.
    expect(connection.createChannel).toHaveBeenCalledTimes(3);
    expect(checks()).toEqual(['missing', 'a', 'missing', 'a']);

    await gate.stop();
  });

  it('warns about a missing queue at most once per interval', async () => {
    const { broker } = makeBroker(new Map());
    const gate       = (await createBackpressureGate(broker as any, config(['missing'])))!;
    const warnings   = () => vi.mocked(logger.warn).mock.calls.filter(([fields]) => (fields as any).queue === 'missing');

    await vi.advanceTimersByTimeAsync(BACKPRESSURE_POLL_MS * 5);
    expect(warnings()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(MISSING_QUEUE_WARN_MS);
    expect(warnings()).toHaveLength(2);

    await gate.stop();
  });

  it('fails open while the broker has never had a connection', async () => {
    const { broker } = makeBroker(new Map([['a', 1_000]]));

    broker.getConnection.mockReturnValue(null);

    const gate = (await createBackpressureGate(broker as any, config(['a'])))!;

    expect(await settled(gate.hold())).toBe(true);

    await gate.stop();
  });

  it('keeps the last depth read while the broker has no connection', async () => {
    const { broker } = makeBroker(new Map([['a', 1_000]]));
    const gate       = (await createBackpressureGate(broker as any, config(['a'])))!;

    broker.getConnection.mockReturnValue(null);
    await vi.advanceTimersByTimeAsync(BACKPRESSURE_POLL_MS * 2);

    expect(await settled(gate.hold())).toBe(false);

    await gate.stop();
  });

  // ── Stop ────────────────────────────────────────────────────────────────────

  it('stop() ends the background reads and closes the depth channel', async () => {
    const { broker, depthChannels, checks } = makeBroker(new Map([['a', 0]]));
    const gate                              = (await createBackpressureGate(broker as any, config(['a'])))!;

    await gate.stop();

    expect(vi.getTimerCount()).toBe(0);
    expect(depthChannels[0].close).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(BACKPRESSURE_POLL_MS * 3);
    expect(checks()).toHaveLength(1);
  });
});
