import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger, RabbitMQ } from '@devvir/service-kit';
import { consumeAndRepublish, REQUEUE_DELAY_MS, FAILURE_LOG_INTERVAL_MS } from '../src/consumer';
import type { Route } from '../src/types';

// ── Mock service-kit ──────────────────────────────────────────────────────────

// vi.hoisted makes the spy available inside the hoisted vi.mock factory below.
const mockRepublish = vi.hoisted(() => vi.fn());

vi.mock('@devvir/service-kit', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  RabbitMQ: {
    // Must be a regular function (not arrow) so `new` works.
    Exchange: vi.fn(function (this: any, channel: unknown, name: string) {
      this.name       = name;
      this.channel    = channel;
      this.republish  = mockRepublish;
      this.setChannel = vi.fn((c: unknown) => { this.channel = c; });
    }),
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Mock consumer and publisher brokers. Returns the consumer channel and a dispatch helper that
 * simulates RabbitMQ delivering a message to a queue's consumer. The publisher is an
 * EventEmitter whose state and exchange map the test can change.
 */
const makeBrokers = () => {
  const handlers = new Map<string, (msg: any) => Promise<void>>();

  const channel = {
    prefetch: vi.fn(async () => ({})),
    ack: vi.fn(),
    nack: vi.fn(),
    consume: vi.fn(async (queue: string, handler: (msg: any) => Promise<void>) => {
      handlers.set(queue, handler);
    }),
  };

  const publisherChannel = { name: 'publisher-channel' };
  const exchanges        = new Map<string, { republish: typeof mockRepublish }>();
  const exchangeFor      = (name: string) => {
    if (! exchanges.has(name)) exchanges.set(name, { republish: mockRepublish });
    return exchanges.get(name);
  };

  const consumer  = { getChannel: vi.fn(() => channel) };
  const publisher = Object.assign(new EventEmitter(), {
    state:       'connected',
    getState:    vi.fn(function (this: { state: string }) { return this.state; }),
    getChannel:  vi.fn(() => publisherChannel),
    getExchange: vi.fn(exchangeFor),
  });

  const deliver = (queue: string, msg: object | null) => handlers.get(queue)?.(msg);

  return { consumer, publisher, channel, publisherChannel, exchanges, deliver };
};

const makeMsg = (body: object, routingKey = '', headers: Record<string, any> = {}, properties: Record<string, any> = {}) => ({
  content: Buffer.from(JSON.stringify(body)),
  fields: { routingKey },
  properties: { headers, ...properties },
});

const bareRoute = (src: string, dst: string): Route => ({
  source: { queue: src },
  destination: { queue: dst },
});

const keyRoute = (value: string, replace?: string): Route => ({
  source: { queue: 'src' },
  destination: {
    exchange: { name: 'out', type: 'topic' },
    routingKey: replace === undefined ? { value } : { value, replace },
  },
});

const config = (routes: Route[], prefetch = 500) => ({
  rabbitmqUrl: '',
  routes,
  prefetch,
  maxReady: 0,
  watchQueues: [],
});

const routingKeysPublished = () => mockRepublish.mock.calls.map((c: any[]) => c[1].routingKey);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('consumeAndRepublish', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRepublish.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('consumes from the source queue', async () => {
    const { consumer, publisher, channel } = makeBrokers();

    await consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), null);

    expect(channel.consume).toHaveBeenCalledWith('src', expect.any(Function));
  });

  // ── Prefetch ────────────────────────────────────────────────────────────────

  it('sets the configured prefetch when backpressure is off', async () => {
    const { consumer, publisher, channel } = makeBrokers();

    await consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')], 42), null);

    expect(channel.prefetch).toHaveBeenCalledWith(42);
  });

  it('starts consuming only once the prefetch is set', async () => {
    const { consumer, publisher, channel } = makeBrokers();
    let release!: () => void;

    channel.prefetch.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({}); }));

    const running = consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), null);

    await new Promise((resolve) => setImmediate(resolve));
    expect(channel.consume).not.toHaveBeenCalled();

    release();
    await running;
    expect(channel.consume).toHaveBeenCalled();
  });

  it('rejects when the prefetch cannot be set', async () => {
    const { consumer, publisher, channel } = makeBrokers();

    channel.prefetch.mockRejectedValueOnce(new Error('channel closed'));

    await expect(consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), null))
      .rejects.toThrow('channel closed');
    expect(channel.consume).not.toHaveBeenCalled();
  });

  it('bare queue: republishes with destination name as routing key', async () => {
    const { consumer, publisher, channel, deliver } = makeBrokers();

    await consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), null);

    const msg = makeMsg({ data: 1 });
    await deliver('src', msg);

    expect(mockRepublish).toHaveBeenCalledWith(msg, expect.objectContaining({ routingKey: 'dst' }));
    expect(channel.ack).toHaveBeenCalledWith(msg);
  });

  it('named exchange: republishes to it with the incoming routing key', async () => {
    const { consumer, publisher, deliver } = makeBrokers();

    const routes: Route[] = [{
      source: { queue: 'src' },
      destination: { exchange: { name: 'out-exchange', type: 'topic' } },
    }];

    await consumeAndRepublish(consumer as any, publisher as any, config(routes), null);

    const msg = makeMsg({ data: 1 }, 'trade.btc');
    await deliver('src', msg);

    expect(publisher.getExchange).toHaveBeenCalledWith('out-exchange');
    expect(mockRepublish).toHaveBeenCalledWith(msg, expect.objectContaining({ routingKey: 'trade.btc' }));
  });

  // ── Setup failures ──────────────────────────────────────────────────────────

  it('rejects when the consumer has no channel', async () => {
    const { consumer, publisher, channel } = makeBrokers();

    consumer.getChannel.mockReturnValue(null as any);

    await expect(consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), null))
      .rejects.toThrow('No RabbitMQ channel available');
    expect(channel.consume).not.toHaveBeenCalled();
  });

  it('rejects when the publisher has no channel', async () => {
    const { consumer, publisher, channel } = makeBrokers();

    publisher.getChannel.mockReturnValue(null as any);

    await expect(consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), null))
      .rejects.toThrow('No RabbitMQ publisher channel available');
    expect(channel.consume).not.toHaveBeenCalled();
  });

  // ── Backpressure ────────────────────────────────────────────────────────────

  it('publishes only once the backpressure gate lets it through', async () => {
    const { consumer, publisher, channel, deliver } = makeBrokers();
    let open!: () => void;

    const hold = vi.fn(() => new Promise<void>((resolve) => { open = resolve; }));

    await consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), hold);

    const msg     = makeMsg({});
    const handled = deliver('src', msg);

    await new Promise((resolve) => setImmediate(resolve));
    expect(hold).toHaveBeenCalledTimes(1);
    expect(mockRepublish).not.toHaveBeenCalled();

    open();
    await handled;

    expect(mockRepublish).toHaveBeenCalledTimes(1);
    expect(channel.ack).toHaveBeenCalledWith(msg);
  });

  // ── Routing keys ────────────────────────────────────────────────────────────

  it.each([
    ['message', 'collect', 'message.trade', 'collect.trade'],
    ['message', 'collect', 'message',       'collect'],
    ['trade',   't',       'bitmex.trade',  'bitmex.trade'],
    ['message', 'collect', 'messages.x',    'messages.x'],
    ['message', 'a$&$1',   'message.trade', 'a$&$1.trade'],
  ])('key:%s:%s turns %s into %s', async (value, replace, incoming, expected) => {
    const { consumer, publisher, deliver } = makeBrokers();

    await consumeAndRepublish(consumer as any, publisher as any, config([keyRoute(value, replace)]), null);

    await deliver('src', makeMsg({}, incoming));

    expect(routingKeysPublished()).toEqual([expected]);
  });

  it('static routing key: always uses the configured value', async () => {
    const { consumer, publisher, deliver } = makeBrokers();

    const routes: Route[] = [{
      source: { queue: 'src' },
      destination: {
        exchange: { name: 'out', type: 'fanout' },
        routingKey: { value: 'fixed-key' },
      },
    }];

    await consumeAndRepublish(consumer as any, publisher as any, config(routes), null);

    await deliver('src', makeMsg({}, 'incoming.ignored'));

    expect(mockRepublish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ routingKey: 'fixed-key' }),
    );
  });

  it('lets an injected header replace an incoming header of the same name', async () => {
    const { consumer, publisher, deliver } = makeBrokers();

    const routes: Route[] = [{
      source: { queue: 'src' },
      destination: { queue: 'dst', headers: { 'x-source': 'router' } },
    }];

    await consumeAndRepublish(consumer as any, publisher as any, config(routes), null);

    await deliver('src', makeMsg({}, '', { 'x-source': 'origin', 'x-other': 'keep' }));

    expect(mockRepublish.mock.calls[0][1].headers).toEqual({ 'x-source': 'router', 'x-other': 'keep' });
  });

  it('merges static headers with incoming message headers', async () => {
    const { consumer, publisher, deliver } = makeBrokers();

    const routes: Route[] = [{
      source: { queue: 'src' },
      destination: { queue: 'dst', headers: { 'x-injected': 'yes' } },
    }];

    await consumeAndRepublish(consumer as any, publisher as any, config(routes), null);

    await deliver('src', makeMsg({}, '', { 'x-existing': 'keep' }));

    expect(mockRepublish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: { 'x-existing': 'keep', 'x-injected': 'yes' },
      }),
    );
  });

  it('fan-out: delivers to all destinations', async () => {
    const { consumer, publisher, deliver } = makeBrokers();

    const routes: Route[] = [
      bareRoute('src', 'dst1'),
      bareRoute('src', 'dst2'),
      bareRoute('src', 'dst3'),
    ];

    await consumeAndRepublish(consumer as any, publisher as any, config(routes), null);

    await deliver('src', makeMsg({ x: 1 }));

    expect(mockRepublish).toHaveBeenCalledTimes(3);
    const keys = mockRepublish.mock.calls.map((c: any[]) => c[1].routingKey);
    expect(keys).toEqual(expect.arrayContaining(['dst1', 'dst2', 'dst3']));
  });

  it('publishes once to a destination that several rules on the queue share', async () => {
    const { consumer, publisher, deliver } = makeBrokers();

    // The expansion of `src@topic:in(key:a) & src@topic:in(key:b) > @topic:out & dst`.
    const routes: Route[] = ['a', 'b'].flatMap((bindingKey): Route[] => [
      { source: { queue: 'src', exchange: { name: 'in', type: 'topic' }, bindingKey }, destination: { exchange: { name: 'out', type: 'topic' } } },
      { source: { queue: 'src', exchange: { name: 'in', type: 'topic' }, bindingKey }, destination: { queue: 'dst' } },
    ]);

    await consumeAndRepublish(consumer as any, publisher as any, config(routes), null);

    await deliver('src', makeMsg({}, 'a'));

    expect(mockRepublish).toHaveBeenCalledTimes(2);
  });

  it('keeps destinations apart that differ in key or headers', async () => {
    const { consumer, publisher, deliver } = makeBrokers();

    const routes: Route[] = [
      { source: { queue: 'src' }, destination: { exchange: { name: 'out', type: 'topic' }, routingKey: { value: 'x' } } },
      { source: { queue: 'src' }, destination: { exchange: { name: 'out', type: 'topic' }, routingKey: { value: 'y' } } },
      { source: { queue: 'src' }, destination: { queue: 'dst', headers: { 'x-a': '1' } } },
      { source: { queue: 'src' }, destination: { queue: 'dst', headers: { 'x-a': '2' } } },
    ];

    await consumeAndRepublish(consumer as any, publisher as any, config(routes), null);

    await deliver('src', makeMsg({}, 'k'));

    expect(mockRepublish).toHaveBeenCalledTimes(4);
  });

  it('logs each route with its exchange types resolved', async () => {
    const { consumer, publisher } = makeBrokers();

    const routes: Route[] = [{ source: { queue: 'src' }, destination: { exchange: { name: 'out' } } }];

    await consumeAndRepublish(consumer as any, publisher as any, config(routes), null);

    expect(logger.info).toHaveBeenCalledWith(
      { source: 'src', routes: ['src > @fanout:out'] },
      'Route established',
    );
  });

  it('acks message after successful delivery', async () => {
    const { consumer, publisher, channel, deliver } = makeBrokers();

    await consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), null);

    const msg = makeMsg({});
    await deliver('src', msg);

    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  // ── Republished properties ──────────────────────────────────────────────────

  it.each([[1, false], [2, true], [undefined, false]])(
    'republishes deliveryMode %s as persistent %s',
    async (deliveryMode, persistent) => {
      const { consumer, publisher, deliver } = makeBrokers();

      await consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), null);

      await deliver('src', makeMsg({}, '', {}, { deliveryMode }));

      expect(mockRepublish.mock.calls[0][1].persistent).toBe(persistent);
    },
  );

  it('does not carry the incoming user id over', async () => {
    const { consumer, publisher, deliver } = makeBrokers();

    await consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), null);

    await deliver('src', makeMsg({}, '', {}, { userId: 'someone-else' }));

    const overrides = mockRepublish.mock.calls[0][1];

    expect('userId' in overrides && overrides.userId === undefined).toBe(true);
  });

  // ── Publishing through the publisher broker ─────────────────────────────────

  it('publishes to a bare queue through the publisher channel, never the consumer channel', async () => {
    const { consumer, publisher, channel, publisherChannel, deliver } = makeBrokers();

    await consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), null);

    await deliver('src', makeMsg({}));

    const Exchange = vi.mocked(RabbitMQ.Exchange);

    expect(Exchange).toHaveBeenCalledTimes(1);
    expect(Exchange).toHaveBeenCalledWith(publisherChannel, '');
    expect(Exchange).not.toHaveBeenCalledWith(channel, expect.anything());
    expect(mockRepublish.mock.contexts[0]).toBe(Exchange.mock.instances[0]);
  });

  it('moves the default exchange onto the publisher channel across reconnections', async () => {
    const { consumer, publisher } = makeBrokers();

    await consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), null);

    const defaultExchange = vi.mocked(RabbitMQ.Exchange).mock.instances[0] as any;
    const newChannel      = { name: 'new-publisher-channel' };

    publisher.emit('disconnect');
    expect(defaultExchange.channel).toBeNull();

    publisher.getChannel.mockReturnValue(newChannel as any);
    publisher.emit('connect');
    expect(defaultExchange.channel).toBe(newChannel);
  });

  it('publishes through the exchange instance the publisher holds now', async () => {
    const { consumer, publisher, exchanges, deliver } = makeBrokers();

    const routes: Route[] = [{ source: { queue: 'src' }, destination: { exchange: { name: 'out', type: 'fanout' } } }];

    await consumeAndRepublish(consumer as any, publisher as any, config(routes), null);

    const recovered = vi.fn(async () => {});

    exchanges.set('out', { republish: recovered });
    await deliver('src', makeMsg({}));

    expect(recovered).toHaveBeenCalledTimes(1);
    expect(mockRepublish).not.toHaveBeenCalled();
  });

  it('requeues a message whose destination exchange the publisher no longer holds', async () => {
    vi.useFakeTimers();

    const { consumer, publisher, channel, exchanges, deliver } = makeBrokers();
    const routes: Route[] = [{ source: { queue: 'src' }, destination: { exchange: { name: 'out', type: 'fanout' } } }];

    await consumeAndRepublish(consumer as any, publisher as any, config(routes), null);

    publisher.getExchange.mockImplementation((name: string) => exchanges.get(name === 'out' ? 'gone' : name));

    const msg     = makeMsg({});
    const handled = deliver('src', msg);

    await vi.advanceTimersByTimeAsync(REQUEUE_DELAY_MS);
    await handled;

    expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ message: 'Destination exchange not found: out' }) }),
      'Failed to route message',
    );
  });

  // ── Acks, nacks and failures ────────────────────────────────────────────────

  describe('on failure', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('requeues after a short delay while the publisher is connected', async () => {
      const { consumer, publisher, channel, deliver } = makeBrokers();

      mockRepublish.mockRejectedValueOnce(new Error('publish failed'));

      await consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), null);

      const msg     = makeMsg({});
      const handled = deliver('src', msg);

      await vi.advanceTimersByTimeAsync(REQUEUE_DELAY_MS - 1);
      expect(channel.nack).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(handled).resolves.toBeUndefined();

      expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
      expect(channel.ack).not.toHaveBeenCalled();
    });

    it('waits for the publisher to reconnect before requeueing', async () => {
      const { consumer, publisher, channel, deliver } = makeBrokers();

      await consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), null);

      publisher.state = 'reconnecting';
      mockRepublish.mockRejectedValue(new Error('Channel closed'));

      const handled = [deliver('src', makeMsg({ n: 1 })), deliver('src', makeMsg({ n: 2 }))];

      await vi.advanceTimersByTimeAsync(60_000);
      expect(channel.nack).not.toHaveBeenCalled();
      expect(publisher.listenerCount('connect')).toBe(2); // the default exchange's and one shared waiter

      publisher.state = 'connected';
      publisher.emit('connect');
      await Promise.all(handled);

      expect(channel.nack).toHaveBeenCalledTimes(2);
    });

    it('nacks once and never acks when a later destination fails', async () => {
      const { consumer, publisher, channel, deliver } = makeBrokers();

      mockRepublish.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('second failed'));

      await consumeAndRepublish(
        consumer as any, publisher as any, config([bareRoute('src', 'dst1'), bareRoute('src', 'dst2')]), null,
      );

      const handled = deliver('src', makeMsg({}));

      await vi.advanceTimersByTimeAsync(REQUEUE_DELAY_MS);
      await handled;

      expect(mockRepublish).toHaveBeenCalledTimes(2);
      expect(channel.nack).toHaveBeenCalledTimes(1);
      expect(channel.ack).not.toHaveBeenCalled();
    });

    it('logs routing failures of a source at most once per interval', async () => {
      const { consumer, publisher, deliver } = makeBrokers();

      mockRepublish.mockRejectedValue(new Error('publish failed'));

      await consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), null);

      const failures = () => vi.mocked(logger.error).mock.calls.filter(([, m]) => m === 'Failed to route message');

      for (let i = 0; i < 3; i++) {
        const handled = deliver('src', makeMsg({}));
        await vi.advanceTimersByTimeAsync(REQUEUE_DELAY_MS);
        await handled;
      }

      expect(failures()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(FAILURE_LOG_INTERVAL_MS);

      const handled = deliver('src', makeMsg({}));
      await vi.advanceTimersByTimeAsync(REQUEUE_DELAY_MS);
      await handled;

      expect(failures()).toHaveLength(2);
      expect(failures()[1][0]).toEqual(expect.objectContaining({ suppressed: 2 }));
    });

    it('survives an ack on a closed channel', async () => {
      const { consumer, publisher, channel, deliver } = makeBrokers();

      channel.ack.mockImplementationOnce(() => { throw new Error('Channel closed'); });

      await consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), null);

      await expect(deliver('src', makeMsg({}))).resolves.toBeUndefined();
      expect(channel.nack).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('survives a nack on a closed channel', async () => {
      const { consumer, publisher, channel, deliver } = makeBrokers();

      mockRepublish.mockRejectedValueOnce(new Error('publish failed'));
      channel.nack.mockImplementationOnce(() => { throw new Error('Channel closed'); });

      await consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), null);

      const handled = deliver('src', makeMsg({}));

      await vi.advanceTimersByTimeAsync(REQUEUE_DELAY_MS);
      await expect(handled).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // ── Consumer cancel ─────────────────────────────────────────────────────────

  it('exits with code 1 when the broker cancels the consumer', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);

    try {
      const { consumer, publisher, channel, deliver } = makeBrokers();

      await consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), null);

      await deliver('src', null);

      expect(exit).toHaveBeenCalledWith(1);
      expect(logger.error).toHaveBeenCalledWith({ source: 'src' }, expect.stringContaining('cancelled'));
      expect(mockRepublish).not.toHaveBeenCalled();
      expect(channel.ack).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });
});
