import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '@devvir/service-kit';
import {
  exitOnConsumerLoss, answerHealthCheck, stopOnShutdown, connectConsumer,
  CONNECT_ATTEMPTS, CONNECT_BASE_DELAY_MS, CONNECT_MAX_DELAY_MS,
} from '../src/lifecycle';

// vi.hoisted makes the brokers' connect results available inside the hoisted vi.mock factory.
const connectResults = vi.hoisted(() => ({ outcomes: [] as Array<Error | null>, brokers: [] as any[] }));

vi.mock('@devvir/service-kit', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  RabbitMQ: {
    // Must be a regular function (not arrow) so `new` works.
    Broker: vi.fn(function (this: any, url: string, options: unknown) {
      this.url             = url;
      this.options         = options;
      this.ensureConnected = vi.fn(async () => {
        const outcome = connectResults.outcomes.shift();
        if (outcome) throw outcome;
      });
      connectResults.brokers.push(this);
    }),
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeBroker = (state = 'connected') => Object.assign(new EventEmitter(), {
  state,
  getState() { return this.state; },
});

/** A service whose 'healthCheck' listeners receive the service first, as service-kit emits them. */
const makeService = () => {
  const service = new EventEmitter();

  const check = () => {
    const res = { statusCode: 0, body: '', writeHead: vi.fn((code: number) => { res.statusCode = code; }), end: vi.fn((b: string) => { res.body = b; }) };

    service.emit('healthCheck', service, res);

    return res;
  };

  return { service, check };
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('exitOnConsumerLoss', () => {
  let exit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
  });

  afterEach(() => {
    exit.mockRestore();
  });

  it.each(['disconnect', 'abort'] as const)('exits with code 1 when the consumer emits %s', (event) => {
    const consumer = makeBroker();

    exitOnConsumerLoss(consumer as any);
    consumer.emit(event, new Error('gone'));

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('keeps running while the consumer is connected', () => {
    const consumer = makeBroker();

    exitOnConsumerLoss(consumer as any);
    consumer.emit('connect');

    expect(exit).not.toHaveBeenCalled();
  });
});

describe('answerHealthCheck', () => {
  it('answers 200 while both brokers are connected', () => {
    const { service, check } = makeService();

    answerHealthCheck(service as any, makeBroker() as any, makeBroker() as any);

    const res = check();

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ healthy: true, brokers: { consumer: 'connected', publisher: 'connected' } });
  });

  it.each([
    ['disconnected', 'connected'],
    ['connected', 'reconnecting'],
    ['connected', 'disconnected'],
  ])('answers 503 when the consumer is %s and the publisher %s', (consumerState, publisherState) => {
    const { service, check } = makeService();

    answerHealthCheck(service as any, makeBroker(consumerState) as any, makeBroker(publisherState) as any);

    expect(check().statusCode).toBe(503);
  });
});

describe('connectConsumer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    connectResults.outcomes = [];
    connectResults.brokers  = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects a broker that does not reconnect on its own', async () => {
    const broker = await connectConsumer('amqp://rabbit');

    expect(broker).toBe(connectResults.brokers[0]);
    expect(connectResults.brokers[0]).toMatchObject({ url: 'amqp://rabbit', options: { retries: 0, managed: true } });
  });

  it('tries again with a doubling wait until it connects', async () => {
    connectResults.outcomes = [new Error('refused'), new Error('refused'), null];

    const connecting = connectConsumer('amqp://rabbit');
    const broker     = connectResults.brokers[0];

    await vi.advanceTimersByTimeAsync(CONNECT_BASE_DELAY_MS);
    expect(broker.ensureConnected).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(CONNECT_BASE_DELAY_MS * 2 - 1);
    expect(broker.ensureConnected).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    await expect(connecting).resolves.toBe(broker);
    expect(broker.ensureConnected).toHaveBeenCalledTimes(3);
  });

  it('rejects with the last error after CONNECT_ATTEMPTS attempts', async () => {
    connectResults.outcomes = Array.from({ length: CONNECT_ATTEMPTS }, (_, i) => new Error(`refused ${i + 1}`));

    const connecting = connectConsumer('amqp://rabbit');
    const outcome    = expect(connecting).rejects.toThrow(`refused ${CONNECT_ATTEMPTS}`);

    await vi.advanceTimersByTimeAsync(CONNECT_MAX_DELAY_MS * CONNECT_ATTEMPTS);
    await outcome;
    expect(connectResults.brokers[0].ensureConnected).toHaveBeenCalledTimes(CONNECT_ATTEMPTS);
  });
});

describe('stopOnShutdown', () => {
  const TIMEOUT_MS = 1_000;

  /** Brokers, routing and gate that record the order of their calls; routing settles on `settle()`. */
  const makeLifecycles = () => {
    const calls: string[] = [];
    let settle!: () => void;

    const lifecycles = {
      consumer:     { close: vi.fn(async () => { calls.push('consumer.close'); }) },
      publisher:    { close: vi.fn(async () => { calls.push('publisher.close'); }) },
      backpressure: { stop: vi.fn(async () => { calls.push('backpressure.stop'); }) },
      routing: {
        stop:    vi.fn(async () => { calls.push('routing.stop'); }),
        settled: vi.fn(() => new Promise<void>((resolve) => {
          settle = () => { calls.push('routing.settled'); resolve(); };
        })),
      },
    };

    return { lifecycles, calls, settle: () => settle() };
  };

  /** Run the service's 'shutdown' listeners as service-kit does, and resolve once all have. */
  const shutDown = (service: EventEmitter) =>
    Promise.all(service.listeners('shutdown').map((fn) => (fn as (...args: any[]) => unknown)(service, 'SIGTERM')));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels the consumers, waits for the deliveries being handled, then closes the publisher and the consumer', async () => {
    const service = new EventEmitter();
    const { lifecycles, calls, settle } = makeLifecycles();

    stopOnShutdown(service as any, lifecycles as any, TIMEOUT_MS);

    const shutdown = shutDown(service);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS / 2);
    expect(calls).toEqual(['backpressure.stop', 'routing.stop']);
    expect(lifecycles.publisher.close).not.toHaveBeenCalled();

    settle();
    await shutdown;

    expect(calls).toEqual(['backpressure.stop', 'routing.stop', 'routing.settled', 'publisher.close', 'consumer.close']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('closes the brokers at the deadline when deliveries are still being handled', async () => {
    const service = new EventEmitter();
    const { lifecycles, calls } = makeLifecycles();

    stopOnShutdown(service as any, lifecycles as any, TIMEOUT_MS);

    const shutdown = shutDown(service);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(lifecycles.publisher.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await shutdown;

    expect(calls).toEqual(['backpressure.stop', 'routing.stop', 'publisher.close', 'consumer.close']);
    expect(logger.warn).toHaveBeenCalledWith({ timeoutMs: TIMEOUT_MS }, expect.stringContaining('still being handled'));
  });

  it('closes the brokers when the consumers cannot be cancelled', async () => {
    const service = new EventEmitter();
    const { lifecycles, calls } = makeLifecycles();

    lifecycles.routing.stop.mockRejectedValueOnce(new Error('Channel closed'));
    stopOnShutdown(service as any, lifecycles as any, TIMEOUT_MS);

    await shutDown(service);

    expect(calls).toEqual(['backpressure.stop', 'publisher.close', 'consumer.close']);
    expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, expect.stringContaining('Could not stop routing'));
  });

  it('closes the consumer when the publisher cannot be closed', async () => {
    const service = new EventEmitter();
    const { lifecycles, settle } = makeLifecycles();

    lifecycles.publisher.close.mockRejectedValueOnce(new Error('already closed'));
    stopOnShutdown(service as any, lifecycles as any, TIMEOUT_MS);

    const shutdown = shutDown(service);

    await vi.advanceTimersByTimeAsync(0);
    settle();
    await shutdown;

    expect(lifecycles.consumer.close).toHaveBeenCalled();
  });

  it('stops without a backpressure gate', async () => {
    const service = new EventEmitter();
    const { lifecycles, settle } = makeLifecycles();

    stopOnShutdown(service as any, { ...lifecycles, backpressure: null } as any, TIMEOUT_MS);

    const shutdown = shutDown(service);

    await vi.advanceTimersByTimeAsync(0);
    settle();
    await shutdown;

    expect(lifecycles.routing.stop).toHaveBeenCalled();
    expect(lifecycles.consumer.close).toHaveBeenCalled();
  });
});
