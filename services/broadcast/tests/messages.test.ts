import { describe, it, expect, vi } from 'vitest';
import { createMessageHandler } from '../src/messages';
import type { State, Config } from '../src/types';

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

  const config: Config = {
    workerUuid:        'test-uuid-1234',
    env:               'live',
    rabbitmqUrl:       'amqp://localhost',
    realtimeWsUrl:     'wss://www.bitmex.com/realtime',
    platformWsUrl:     'wss://www.bitmex.com/realtimePlatform',
    channels:          ['trade', 'announcement'],
    bouncerUrl:        'http://bouncer:3000',
    bouncerToken:      'test-token',
  };

  const exchange = { publish: vi.fn().mockResolvedValue(undefined) };
  const broker   = { getExchange: vi.fn(() => exchange) };

  const service = {
    state:     (key?: string) => (key !== undefined ? (state as Record<string, unknown>)[key] : state),
    setState:  (key: string, value: unknown) => { (state as Record<string, unknown>)[key] = value; return value; },
    config:    () => config,
    providers: { get: vi.fn(() => broker) },
  };

  return { service, state, config, exchange };
};

// ── Message fixtures ──────────────────────────────────────────────────────────

const buf = (data: unknown): Buffer => Buffer.from(JSON.stringify(data));

const dataMsg = (table = 'trade', action = 'insert') => ({
  table,
  action,
  data: [{ symbol: 'XBTUSD', timestamp: '2026-01-01T00:00:00.000Z' }],
});

const infoMsg = (version = '1.0.0') => ({
  info:      'Welcome to the BitMEX Realtime API.',
  version,
  timestamp: '2026-01-01T00:00:00.000Z',
  docs:      'https://www.bitmex.com/app/wsAPI',
});

// ── Publishing ────────────────────────────────────────────────────────────────

describe('data messages: publishing', () => {
  it('publishes to the exchange for every data message', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(dataMsg()));

    expect(exchange.publish).toHaveBeenCalledOnce();
  });

  it('uses table.action as routing key', async () => {
    const cases: [string, string][] = [
      ['trade',       'insert'],
      ['quote',       'partial'],
      ['orderBookL2', 'update'],
      ['instrument',  'delete'],
    ];

    for (const [table, action] of cases) {
      const { service, exchange } = makeService();
      const handler = createMessageHandler(service as any, vi.fn());

      await handler(buf(dataMsg(table, action)));

      expect(exchange.publish.mock.calls[0][1]).toBe(`${table}.${action}`);
    }
  });

  it('publishes the original message as a JSON Buffer', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());
    const msg = dataMsg('quote', 'update');

    await handler(buf(msg));

    const content = exchange.publish.mock.calls[0][0] as Buffer;

    expect(Buffer.isBuffer(content)).toBe(true);
    expect(JSON.parse(content.toString())).toMatchObject(msg);
  });

  it('increments x-message-count with each publish', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(dataMsg()));
    await handler(buf(dataMsg()));
    await handler(buf(dataMsg()));

    const counts = exchange.publish.mock.calls.map(call => (call[2] as any).headers['x-message-count']);

    expect(counts).toEqual(['1', '2', '3']);
  });

  it('includes x-worker-uuid from config', async () => {
    const { service, config, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(dataMsg()));

    const headers = (exchange.publish.mock.calls[0][2] as any).headers;

    expect(headers['x-worker-uuid']).toBe(config.workerUuid);
  });

  it('includes x-bitmex-published-at as a parseable timestamp', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(dataMsg()));

    const ts = (exchange.publish.mock.calls[0][2] as any).headers['x-bitmex-published-at'];

    expect(typeof ts).toBe('string');
    expect(new Date(ts).getTime()).not.toBeNaN();
  });

  it('includes empty x-bitmex-version before any info message arrives', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(dataMsg()));

    expect((exchange.publish.mock.calls[0][2] as any).headers['x-bitmex-version']).toBe('');
  });

  it('includes api version in headers once an info message has been received', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(infoMsg('2.5.0')));
    await handler(buf(dataMsg()));

    expect((exchange.publish.mock.calls[0][2] as any).headers['x-bitmex-version']).toBe('2.5.0');
  });

  it('includes x-account-id from accountId argument', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(dataMsg()), 'acc-42');

    expect((exchange.publish.mock.calls[0][2] as any).headers['x-account-id']).toBe('acc-42');
  });

  it('includes empty x-account-id for guest messages', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(dataMsg()));

    expect((exchange.publish.mock.calls[0][2] as any).headers['x-account-id']).toBe('');
  });

  it('calls the onMessage callback after each publish', async () => {
    const { service } = makeService();
    const onMessage = vi.fn();
    const handler = createMessageHandler(service as any, onMessage);

    await handler(buf(dataMsg()));
    await handler(buf(dataMsg()));

    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it('updates lastMessageTime on every call', async () => {
    const { service, state } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());
    const before = Date.now();

    await handler(buf(dataMsg()));

    expect(state.lastMessageTime).toBeGreaterThanOrEqual(before);
  });
});

// ── Control messages ──────────────────────────────────────────────────────────

describe('control messages: no publish', () => {
  it('skips publish on subscription confirmation', async () => {
    const { service, exchange } = makeService();
    const onMessage = vi.fn();
    const handler = createMessageHandler(service as any, onMessage);

    await handler(buf({ subscribe: 'trade', success: true }));

    expect(exchange.publish).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('skips publish on unsubscription confirmation', async () => {
    const { service, exchange } = makeService();
    const onMessage = vi.fn();
    const handler = createMessageHandler(service as any, onMessage);

    await handler(buf({ unsubscribe: 'trade', success: true }));

    expect(exchange.publish).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('skips publish on info message', async () => {
    const { service, exchange } = makeService();
    const onMessage = vi.fn();
    const handler = createMessageHandler(service as any, onMessage);

    await handler(buf(infoMsg()));

    expect(exchange.publish).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('retains only the first info message version', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(infoMsg('2.5.0')));
    await handler(buf(infoMsg('3.0.0')));
    await handler(buf(dataMsg()));

    expect((exchange.publish.mock.calls[0][2] as any).headers['x-bitmex-version']).toBe('2.5.0');
  });

  it('skips publish on unrecognized message shapes', async () => {
    const { service, exchange } = makeService();
    const onMessage = vi.fn();
    const handler = createMessageHandler(service as any, onMessage);

    await handler(buf({ unexpected: true, whatever: 123 }));

    expect(exchange.publish).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe('error handling', () => {
  it('resolves without publishing on invalid JSON', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await expect(handler(Buffer.from('{bad json}'))).resolves.toBeUndefined();

    expect(exchange.publish).not.toHaveBeenCalled();
  });

  it('rethrows Channel closed errors', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    exchange.publish.mockRejectedValueOnce(new Error('Channel closed'));

    await expect(handler(buf(dataMsg()))).rejects.toThrow('Channel closed');
  });

  it('swallows other publish errors without propagating', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    exchange.publish.mockRejectedValueOnce(new Error('Connection reset'));

    await expect(handler(buf(dataMsg()))).resolves.toBeUndefined();
  });
});
