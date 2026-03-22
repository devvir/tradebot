import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── shared connection mock ────────────────────────────────────────────────────

const { mockChannel, mockConnection } = vi.hoisted(() => {
  const mockChannel = {
    assertQueue: vi.fn().mockResolvedValue({ messageCount: 5, consumerCount: 1 }),
    checkQueue: vi.fn().mockResolvedValue({ messageCount: 5, consumerCount: 1 }),
    prefetch: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockResolvedValue({ consumerTag: 'ct' }),
    get: vi.fn().mockResolvedValue(false),
    nack: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const mockConnection = {
    close: vi.fn().mockResolvedValue(undefined),
  };

  return { mockChannel, mockConnection };
});

vi.mock('../../src/shared/connections/rabbitmq', () => ({
  connectRabbit: vi.fn().mockResolvedValue({
    connection: mockConnection,
    channel: mockChannel,
    url: 'amqp://guest:guest@localhost:5672',
    mgmtUrl: 'http://localhost:15672/api',
    mgmtAuth: 'Z3Vlc3Q6Z3Vlc3Q=',
  }),
}));

import { run } from '../../src/tools/rabbitmq/index';

describe('rabbitmq tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannel.assertQueue.mockResolvedValue({ messageCount: 5, consumerCount: 1 });
    mockChannel.checkQueue.mockResolvedValue({ messageCount: 5, consumerCount: 1 });
    mockChannel.get.mockResolvedValue(false);
    mockChannel.consume.mockResolvedValue({ consumerTag: 'ct' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
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
    it('calls channel.get() for the queue', async () => {
      await run('my-queue', { messages: '5' });
      expect(mockChannel.get).toHaveBeenCalledWith('my-queue', { noAck: true });
    });

    it('closes channel and connection after fetching', async () => {
      await run('my-queue', {});
      expect(mockChannel.close).toHaveBeenCalled();
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it('displays fetched JSON messages', async () => {
      const payload = { event: 'test', val: 42 };
      mockChannel.get
        .mockResolvedValueOnce({ content: Buffer.from(JSON.stringify(payload)) })
        .mockResolvedValueOnce(false);

      await run('my-queue', {});

      const output = vi.mocked(console.log).mock.calls.map(c => String(c[0])).join('\n');
      expect(output).toContain('"event": "test"');
    });
  });

  describe('watch mode', () => {
    it('calls channel.prefetch(1) before channel.consume', async () => {
      const callOrder: string[] = [];

      mockChannel.prefetch.mockImplementation(() => {
        callOrder.push('prefetch');
        return Promise.resolve();
      });

      mockChannel.consume.mockImplementation(() => {
        callOrder.push('consume');
        return Promise.resolve({ consumerTag: 'ct' });
      });

      run('my-queue', { watch: true }).catch(() => {});
      await new Promise(resolve => setImmediate(resolve));

      expect(callOrder.indexOf('prefetch')).toBeLessThan(callOrder.indexOf('consume'));
    });

    it('nacks messages with requeue=true to keep them in the queue', async () => {
      let consumeHandler: ((msg: any) => void) | undefined;

      mockChannel.consume.mockImplementation((_q: string, h: (msg: any) => void) => {
        consumeHandler = h;
        return Promise.resolve({ consumerTag: 'ct' });
      });

      run('my-queue', { watch: true }).catch(() => {});
      await new Promise(resolve => setImmediate(resolve));

      const msg = { content: Buffer.from(JSON.stringify({ x: 1 })) };
      consumeHandler!(msg);

      expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, true);
    });
  });

  describe('list mode', () => {
    it('closes channel and connection after listing', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([{ name: 'q1', messages: 3, messages_ready: 3, consumers: 0 }]),
      }) as any;

      await run(undefined, { list: true });

      expect(mockChannel.close).toHaveBeenCalled();
      expect(mockConnection.close).toHaveBeenCalled();
    });
  });
});
