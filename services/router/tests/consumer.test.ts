import { describe, it, expect, vi, beforeEach } from 'vitest';
import { consumeAndRepublish } from '../src/consumer';
import type { Route } from '../src/types';

// ── Mock service-kit ──────────────────────────────────────────────────────────

// vi.hoisted makes the spy available inside the hoisted vi.mock factory below.
const mockRepublish = vi.hoisted(() => vi.fn());

vi.mock('@devvir/service-kit', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
  RabbitMQ: {
    // Must be a regular function (not arrow) so `new` works.
    Exchange: vi.fn(function (this: { republish: typeof mockRepublish }) {
      this.republish = mockRepublish;
    }),
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Mock consumer broker. Returns the channel and a dispatch helper that
 * simulates RabbitMQ delivering a message to a queue's consumer.
 */
const makeBrokers = () => {
  const handlers = new Map<string, (msg: any) => Promise<void>>();

  const channel = {
    prefetch: vi.fn(),
    ack: vi.fn(),
    nack: vi.fn(),
    consume: vi.fn(async (queue: string, handler: (msg: any) => Promise<void>) => {
      handlers.set(queue, handler);
    }),
  };

  const mockExchangeInstance = { republish: mockRepublish };

  const consumer = { getChannel: vi.fn(() => channel) };
  const publisher = { getExchange: vi.fn(() => mockExchangeInstance) };

  const deliver = (queue: string, msg: object) => handlers.get(queue)?.(msg);

  return { consumer, publisher, channel, deliver };
};

const makeMsg = (body: object, routingKey = '', headers: Record<string, any> = {}) => ({
  content: Buffer.from(JSON.stringify(body)),
  fields: { routingKey },
  properties: { headers },
});

const bareRoute = (src: string, dst: string): Route => ({
  source: { queue: src },
  destination: { queue: dst },
});

const config = (routes: Route[]) => ({
  rabbitmqUrl: '',
  routes,
  maxReady: 0,
  watchQueues: [],
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('consumeAndRepublish', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('consumes from the source queue', async () => {
    const { consumer, publisher, channel } = makeBrokers();

    await consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), null);

    expect(channel.consume).toHaveBeenCalledWith('src', expect.any(Function));
  });

  it('bare queue: republishes with destination name as routing key', async () => {
    const { consumer, publisher, channel, deliver } = makeBrokers();

    await consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), null);

    const msg = makeMsg({ data: 1 });
    await deliver('src', msg);

    expect(mockRepublish).toHaveBeenCalledWith(msg, expect.objectContaining({ routingKey: 'dst' }));
    expect(channel.ack).toHaveBeenCalledWith(msg);
  });

  it('named exchange: calls getExchange and republishes to it', async () => {
    const { consumer, publisher, deliver } = makeBrokers();

    const routes: Route[] = [{
      source: { queue: 'src' },
      destination: { exchange: { name: 'out-exchange', type: 'fanout' } },
    }];

    await consumeAndRepublish(consumer as any, publisher as any, config(routes), null);

    const msg = makeMsg({ data: 1 });
    await deliver('src', msg);

    expect(publisher.getExchange).toHaveBeenCalledWith('out-exchange');
    expect(mockRepublish).toHaveBeenCalledWith(msg, expect.objectContaining({ routingKey: '' }));
  });

  it('routing key prefix replace: message.trade → collect.trade', async () => {
    const { consumer, publisher, deliver } = makeBrokers();

    const routes: Route[] = [{
      source: { queue: 'src' },
      destination: {
        exchange: { name: 'out', type: 'topic' },
        routingKey: { value: 'message', replace: 'collect' },
      },
    }];

    await consumeAndRepublish(consumer as any, publisher as any, config(routes), null);

    await deliver('src', makeMsg({}, 'message.trade'));

    expect(mockRepublish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ routingKey: 'collect.trade' }),
    );
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

  it('acks message after successful delivery', async () => {
    const { consumer, publisher, channel, deliver } = makeBrokers();

    await consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), null);

    const msg = makeMsg({});
    await deliver('src', msg);

    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('nacks and does not throw when republish fails', async () => {
    const { consumer, publisher, channel, deliver } = makeBrokers();

    mockRepublish.mockRejectedValueOnce(new Error('publish failed'));

    await consumeAndRepublish(consumer as any, publisher as any, config([bareRoute('src', 'dst')]), null);

    const msg = makeMsg({});
    await deliver('src', msg);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
    expect(channel.ack).not.toHaveBeenCalled();
  });
});
