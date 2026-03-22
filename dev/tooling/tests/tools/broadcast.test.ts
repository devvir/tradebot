import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── shared connection mock ────────────────────────────────────────────────────

const { mockChannel, mockConnection } = vi.hoisted(() => {
  const mockChannel = {
    assertExchange: vi.fn().mockResolvedValue(undefined),
    assertQueue: vi.fn().mockResolvedValue({ queue: 'tmp-q' }),
    bindQueue: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockResolvedValue({ consumerTag: 'ct' }),
    ack: vi.fn(),
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

import { run } from '../../src/tools/broadcast/index';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeMsg(payload: object): { content: Buffer } {
  return { content: Buffer.from(JSON.stringify(payload)) };
}

async function setupAndGetHandler(options: Parameters<typeof run>[0] = {}) {
  let handler: ((msg: any) => void) | undefined;

  mockChannel.consume.mockImplementation((_queue: string, h: (msg: any) => void) => {
    handler = h;
    return Promise.resolve({ consumerTag: 'ct' });
  });

  run(options).catch(() => {});
  await new Promise(resolve => setImmediate(resolve));

  return handler!;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('broadcast tool — filter logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannel.assertExchange.mockResolvedValue(undefined);
    mockChannel.assertQueue.mockResolvedValue({ queue: 'tmp-q' });
    mockChannel.bindQueue.mockResolvedValue(undefined);
    mockChannel.consume.mockResolvedValue({ consumerTag: 'ct' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('acks and does not print JSON for a message that does not match --type', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = await setupAndGetHandler({ type: 'OrderUpdate' });

    const wrongMsg = makeMsg({ type: 'TradeExecuted', data: 'ignored' });
    handler(wrongMsg);

    expect(mockChannel.ack).toHaveBeenCalledWith(wrongMsg);

    const jsonPrints = spy.mock.calls.map(c => String(c[0])).filter(s => s.includes('"type"'));
    expect(jsonPrints).toHaveLength(0);
  });

  it('prints and acks a message that matches --type', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = await setupAndGetHandler({ type: 'OrderUpdate' });

    const matchMsg = makeMsg({ type: 'OrderUpdate', orderId: 'abc' });
    handler(matchMsg);

    expect(mockChannel.ack).toHaveBeenCalledWith(matchMsg);

    const output = spy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('OrderUpdate');
  });

  it('passes all messages through when no --type filter is set', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = await setupAndGetHandler({});

    handler(makeMsg({ type: 'OrderUpdate' }));
    handler(makeMsg({ type: 'TradeExecuted' }));

    expect(mockChannel.ack).toHaveBeenCalledTimes(2);
  });

  it('only prints JSON for messages that pass the filter', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = await setupAndGetHandler({ type: 'OrderUpdate' });

    handler(makeMsg({ type: 'TradeExecuted' }));
    handler(makeMsg({ type: 'OrderUpdate' }));
    handler(makeMsg({ type: 'OrderUpdate' }));

    const jsonPrints = spy.mock.calls
      .map(c => String(c[0]))
      .filter(s => s.includes('"type"'));

    expect(jsonPrints).toHaveLength(2);
  });

  it('binds to the broadcast fanout exchange', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await setupAndGetHandler({});
    expect(mockChannel.assertExchange).toHaveBeenCalledWith('broadcast', 'fanout', expect.any(Object));
    expect(mockChannel.bindQueue).toHaveBeenCalledWith('tmp-q', 'broadcast', '');
  });
});
