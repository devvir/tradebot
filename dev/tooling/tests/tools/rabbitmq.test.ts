import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';

// ── shared connection mock ────────────────────────────────────────────────────

const { mockChannel, mockConnection } = vi.hoisted(() => {
  const mockChannel = {
    assertQueue: vi.fn(),
    checkQueue: vi.fn(),
    bindQueue: vi.fn(),
    prefetch: vi.fn(),
    consume: vi.fn(),
    get: vi.fn(),
    ack: vi.fn(),
    nack: vi.fn(),
    nackAll: vi.fn(),
    close: vi.fn(),
  };

  const mockConnection = {
    close: vi.fn(),
  };

  return { mockChannel, mockConnection };
});

vi.mock('../../src/shared/connections/rabbitmq', () => ({
  connectRabbit: vi.fn(),
}));

import { connectRabbit } from '../../src/shared/connections/rabbitmq';
import { run } from '../../src/tools/rabbitmq/index';
import { register } from '../../src/commands/rabbit';

const MGMT = 'http://localhost:15672/api';

const connected = {
  connection: mockConnection,
  channel: mockChannel,
  url: 'amqp://guest:guest@localhost:5672',
  mgmtUrl: MGMT,
  mgmtAuth: 'Z3Vlc3Q6Z3Vlc3Q=',
};

/** A fetch answering the management API from `routes` (path after /api → JSON body). */
function mgmt(routes: Record<string, unknown>) {
  global.fetch = vi.fn(async (url: string) => {
    const path = String(url).slice(MGMT.length);

    if (! (path in routes)) return { ok: false, status: 404, json: async () => ({}) };

    return { ok: true, status: 200, json: async () => routes[path] };
  }) as any;

  return vi.mocked(global.fetch);
}

const QUEUE_PATH = '/queues/%2F/my-queue';

const classicQueue = (bindings: unknown[]) => mgmt({
  [QUEUE_PATH]: { name: 'my-queue', type: 'classic' },
  [`${QUEUE_PATH}/bindings`]: bindings,
});

const DEFAULT_BINDING = { source: '', destination: 'my-queue', routing_key: 'my-queue', arguments: {} };
const TICKS_BINDING = { source: 'ticks', destination: 'my-queue', routing_key: 'btc.*', arguments: {} };
const HEADERS_BINDING = { source: 'events', destination: 'my-queue', routing_key: '', arguments: { 'x-match': 'all', kind: 'trade' } };

function message(body: unknown, fields: Record<string, unknown> = {}) {
  return { content: Buffer.from(JSON.stringify(body)), fields: { redelivered: false, ...fields } };
}

/** Signal handlers the code under test registers, without touching the test process's own. */
function captureSignals() {
  const handlers: Record<string, Array<() => unknown>> = {};

  vi.spyOn(process, 'on').mockImplementation(((event: string, handler: () => unknown) => {
    (handlers[event] ??= []).push(handler);
    return process;
  }) as any);
  vi.spyOn(process, 'off').mockImplementation(((event: string, handler: () => unknown) => {
    handlers[event] = (handlers[event] ?? []).filter(h => h !== handler);
    return process;
  }) as any);
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);

  return { handlers, exit };
}

/** The handler given to channel.consume, once the watch has subscribed. */
async function consumeHandler(): Promise<(msg: any) => void> {
  await vi.waitFor(() => expect(mockChannel.consume).toHaveBeenCalled());
  return mockChannel.consume.mock.calls[0][1];
}

function printed(): string {
  return vi.mocked(console.log).mock.calls.map(c => c.join(' ')).join('\n');
}

function printedErr(): string {
  return vi.mocked(console.error).mock.calls.map(c => c.join(' ')).join('\n');
}

describe('rabbitmq tool', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(connectRabbit).mockResolvedValue(connected as any);
    mockChannel.assertQueue.mockResolvedValue({ queue: 'amq.gen-tap', messageCount: 0, consumerCount: 0 });
    mockChannel.checkQueue.mockResolvedValue({ queue: 'my-queue', messageCount: 5, consumerCount: 1 });
    mockChannel.bindQueue.mockResolvedValue({});
    mockChannel.prefetch.mockResolvedValue(undefined);
    mockChannel.consume.mockResolvedValue({ consumerTag: 'ct' });
    mockChannel.get.mockResolvedValue(false);
    mockChannel.close.mockResolvedValue(undefined);
    mockConnection.close.mockResolvedValue(undefined);
    mgmt({ [QUEUE_PATH]: { name: 'my-queue', type: 'classic' } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('no queue arg', () => {
    it('warns and disconnects when no queue is given without --list', async () => {
      await run(undefined, {});
      expect(mockChannel.close).toHaveBeenCalled();
      expect(mockConnection.close).toHaveBeenCalled();
    });
  });

  describe('fetch mode (default)', () => {
    it('gets messages unacknowledged, so the broker keeps them', async () => {
      await run('my-queue', { messages: '5' });
      expect(mockChannel.get).toHaveBeenCalledWith('my-queue', { noAck: false });
      expect(mockChannel.get).not.toHaveBeenCalledWith('my-queue', expect.objectContaining({ noAck: true }));
    });

    it('requeues every fetched message after the gets and before closing', async () => {
      const order: string[] = [];
      mockChannel.get.mockImplementation(async () => {
        order.push('get');
        return order.filter(o => o === 'get').length <= 3 ? message({ n: order.length }) : false;
      });
      mockChannel.nackAll.mockImplementation(() => { order.push('nackAll'); });
      mockChannel.close.mockImplementation(async () => { order.push('close'); });

      await run('my-queue', {});

      expect(mockChannel.nackAll).toHaveBeenCalledWith(true);
      expect(order).toEqual(['get', 'get', 'get', 'get', 'nackAll', 'close']);
    });

    it('stops at --messages, and at 10 when it is not given', async () => {
      mockChannel.get.mockResolvedValue(message({ x: 1 }));

      await run('my-queue', { messages: '3' });
      expect(mockChannel.get).toHaveBeenCalledTimes(3);

      mockChannel.get.mockClear();
      await run('my-queue', {});
      expect(mockChannel.get).toHaveBeenCalledTimes(10);
    });

    it('still requeues when printing fails', async () => {
      mockChannel.get.mockResolvedValueOnce(message({ x: 1 })).mockResolvedValueOnce(false);
      vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
        if (String(args[0]).includes('"x"')) throw new Error('stdout closed');
      });

      await expect(run('my-queue', {})).rejects.toThrow('stdout closed');

      expect(mockChannel.nackAll).toHaveBeenCalledWith(true);
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it('still requeues what it holds when a later get fails', async () => {
      mockChannel.get.mockResolvedValueOnce(message({ x: 1 })).mockRejectedValueOnce(new Error('channel closed'));

      await expect(run('my-queue', {})).rejects.toThrow('channel closed');

      expect(mockChannel.nackAll).toHaveBeenCalledWith(true);
    });

    it('closes channel and connection after fetching', async () => {
      await run('my-queue', {});
      expect(mockChannel.close).toHaveBeenCalled();
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it('displays fetched JSON messages', async () => {
      mockChannel.get
        .mockResolvedValueOnce(message({ event: 'test', val: 42 }))
        .mockResolvedValueOnce(false);

      await run('my-queue', {});

      expect(printed()).toContain('"event": "test"');
    });

    it('refuses a stream queue without reading it', async () => {
      mgmt({ [QUEUE_PATH]: { name: 'my-queue', type: 'stream' } });

      await expect(run('my-queue', {})).rejects.toThrow(/stream/);

      expect(mockChannel.get).not.toHaveBeenCalled();
    });

    it('fetches when the management API cannot say what type the queue is', async () => {
      vi.mocked(connectRabbit).mockResolvedValueOnce({
        ...connected, mgmtUrl: undefined, mgmtUnavailable: 'no management port',
      } as any);

      await run('my-queue', {});

      expect(mockChannel.get).toHaveBeenCalledWith('my-queue', { noAck: false });
    });

    it('rejects a --messages that is not a positive whole number', async () => {
      await expect(run('my-queue', { messages: 'lots' })).rejects.toThrow('--messages');
      expect(mockChannel.get).not.toHaveBeenCalled();
      expect(mockConnection.close).toHaveBeenCalled();
    });
  });

  describe('a queue that does not exist', () => {
    it('says so, pointing at --list', async () => {
      mockChannel.checkQueue.mockRejectedValueOnce(Object.assign(new Error('NOT_FOUND - no queue'), { code: 404 }));
      mockChannel.close.mockRejectedValueOnce(new Error('Channel closed'));

      await expect(run('nope', {})).rejects.toThrow("Queue 'nope' not found - run with --list");

      expect(mockConnection.close).toHaveBeenCalled();
    });

    it('is reported once by the rabbit command', async () => {
      mockChannel.checkQueue.mockRejectedValueOnce(Object.assign(new Error('NOT_FOUND - no queue'), { code: 404 }));
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
      const program = new Command();
      register(program);

      await program.parseAsync(['node', 'tools', 'rabbit', 'nope']);

      const reports = [...vi.mocked(console.error).mock.calls, ...vi.mocked(console.log).mock.calls]
        .map(c => c.join(' '))
        .filter(line => line.includes('not found'));
      expect(reports).toHaveLength(1);
      expect(reports[0]).toContain("Queue 'nope' not found - run with --list");
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  describe('watch mode', () => {
    it('taps the queue\'s exchange bindings through a private queue, never the queue itself', async () => {
      classicQueue([DEFAULT_BINDING, TICKS_BINDING, HEADERS_BINDING]);
      captureSignals();

      void run('my-queue', { watch: true }).catch(() => {});
      const handler = await consumeHandler();

      expect(mockChannel.assertQueue).toHaveBeenCalledWith('', expect.objectContaining({ exclusive: true, autoDelete: true }));
      expect(mockChannel.bindQueue).toHaveBeenCalledTimes(2);
      expect(mockChannel.bindQueue).toHaveBeenCalledWith('amq.gen-tap', 'ticks', 'btc.*', {});
      expect(mockChannel.bindQueue).toHaveBeenCalledWith('amq.gen-tap', 'events', '', { 'x-match': 'all', kind: 'trade' });
      expect(mockChannel.consume).toHaveBeenCalledWith('amq.gen-tap', expect.any(Function), { noAck: true });

      handler(message({ x: 1 }, { exchange: 'ticks', routingKey: 'btc.usd' }));

      expect(printed()).toContain('"x": 1');
      expect(mockChannel.consume.mock.calls.map(c => c[0])).not.toContain('my-queue');
      expect(mockChannel.get).not.toHaveBeenCalled();
      expect(mockChannel.nack).not.toHaveBeenCalled();
      expect(mockChannel.ack).not.toHaveBeenCalled();
    });

    it('warns and consumes nothing when the queue is bound only to the default exchange', async () => {
      classicQueue([DEFAULT_BINDING]);
      captureSignals();

      await run('my-queue', { watch: true });

      expect(mockChannel.consume).not.toHaveBeenCalled();
      expect(mockChannel.assertQueue).not.toHaveBeenCalled();
      expect(printedErr()).toContain('nothing to watch');
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it('fails, consuming nothing, when the bindings cannot be read', async () => {
      mgmt({ [QUEUE_PATH]: { name: 'my-queue', type: 'classic' } });
      captureSignals();

      await expect(run('my-queue', { watch: true })).rejects.toThrow(/management API/);

      expect(mockChannel.consume).not.toHaveBeenCalled();
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it('fails, consuming nothing, without the management API', async () => {
      vi.mocked(connectRabbit).mockResolvedValueOnce({
        ...connected, mgmtUrl: undefined, mgmtUnavailable: 'no management port',
      } as any);
      captureSignals();

      await expect(run('my-queue', { watch: true })).rejects.toThrow('no management port');

      expect(mockChannel.consume).not.toHaveBeenCalled();
    });

    it('with --messages 2, disconnects after two deliveries', async () => {
      classicQueue([TICKS_BINDING]);
      const { exit } = captureSignals();

      const done = run('my-queue', { watch: true, messages: '2' });
      const handler = await consumeHandler();

      handler(message({ n: 1 }));
      expect(mockConnection.close).not.toHaveBeenCalled();
      handler(message({ n: 2 }));

      await done;

      expect(mockChannel.close).toHaveBeenCalledTimes(1);
      expect(mockConnection.close).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();
    });

    it('without --messages, keeps watching past ten deliveries', async () => {
      classicQueue([TICKS_BINDING]);
      captureSignals();
      const program = new Command();
      register(program);

      void program.parseAsync(['node', 'tools', 'rabbit', 'my-queue', '--watch']);
      const handler = await consumeHandler();

      for (let n = 1; n <= 12; n++) handler(message({ n }));
      await new Promise(resolve => setImmediate(resolve));

      expect(printed()).toContain('"n": 12');
      expect(mockConnection.close).not.toHaveBeenCalled();
    });

    it('reads a stream queue from its next offset and acks what it reads', async () => {
      mgmt({ [QUEUE_PATH]: { name: 'my-queue', type: 'stream' } });
      captureSignals();

      void run('my-queue', { watch: true }).catch(() => {});
      const handler = await consumeHandler();

      expect(mockChannel.prefetch).toHaveBeenCalled();
      expect(mockChannel.consume).toHaveBeenCalledWith('my-queue', expect.any(Function), {
        noAck: false,
        arguments: { 'x-stream-offset': 'next' },
      });

      const msg = message({ s: 1 });
      handler(msg);

      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
      expect(mockChannel.nack).not.toHaveBeenCalled();
      expect(mockChannel.bindQueue).not.toHaveBeenCalled();
    });

    it('stops once on a doubled Ctrl+C, swallowing the second close\'s error', async () => {
      classicQueue([TICKS_BINDING]);
      const { handlers, exit } = captureSignals();
      mockChannel.close
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Channel closing'));

      void run('my-queue', { watch: true });
      await consumeHandler();

      expect(handlers.SIGINT).toHaveLength(1);
      expect(handlers.SIGTERM).toHaveLength(1);

      const sigint = handlers.SIGINT[0];
      const first = sigint();
      const second = sigint();

      await expect(Promise.all([first, second])).resolves.toBeDefined();
      expect(mockChannel.close).toHaveBeenCalledTimes(1);
      expect(mockConnection.close).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  describe('list mode', () => {
    it('closes channel and connection after listing', async () => {
      mgmt({ '/queues': [{ name: 'q1', messages: 3, messages_ready: 3, consumers: 0 }] });

      await run(undefined, { list: true });

      expect(printed()).toContain('q1');
      expect(mockChannel.close).toHaveBeenCalled();
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it('reports why there is no management API instead of fetching', async () => {
      vi.mocked(connectRabbit).mockResolvedValueOnce({
        connection: mockConnection,
        channel: mockChannel,
        url: 'amqp://guest:guest@localhost:32771',
        mgmtUnavailable: 'container rabbitmq does not publish the management port 15672',
        mgmtAuth: 'Z3Vlc3Q6Z3Vlc3Q=',
      } as any);
      global.fetch = vi.fn() as any;

      await expect(run(undefined, { list: true })).rejects.toThrow(
        /Cannot list queues without the management API: .*does not publish the management port 15672/,
      );

      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it('throws when the management API cannot give the queue list', async () => {
      mgmt({});

      await expect(run(undefined, { list: true })).rejects.toThrow(/Could not fetch the queue list/);

      expect(mockConnection.close).toHaveBeenCalled();
    });

    it('connects to the --url given', async () => {
      await run('my-queue', { url: 'amqp://u:p@broker.lan:5672' });

      expect(connectRabbit).toHaveBeenCalledWith({ url: 'amqp://u:p@broker.lan:5672' });
    });
  });

  describe('virtual host', () => {
    it('asks the management API about the vhost the AMQP URL names', async () => {
      vi.mocked(connectRabbit).mockResolvedValueOnce({ ...connected, url: 'amqp://u:p@broker:5672/trading' } as any);
      const fetch = mgmt({ '/queues/trading/my-queue': { type: 'classic' } });

      await run('my-queue', {});

      expect(String(fetch.mock.calls[0][0])).toBe(`${MGMT}/queues/trading/my-queue`);
    });
  });
});
