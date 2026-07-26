import { describe, it, expect, vi } from 'vitest';
import { createMessageHandler } from '../src/messages';
import type { State, Config } from '../src/types';

// ── Service mock ──────────────────────────────────────────────────────────────

const makeService = (stateOverrides: Partial<State> = {}) => {
  const state: State = {
    broker:          null,
    isShuttingDown:  false,
    lastMessageTime: 0,
    ...stateOverrides,
  };

  const config: Config = {
    workerUuid:  'test-uuid-1234',
    rabbitmqUrl: 'amqp://localhost',
    venues:      ['bitmex'],
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

    await handler(buf(dataMsg()), 'bitmex');

    expect(exchange.publish).toHaveBeenCalledOnce();
  });

  // The routing key is the venue and nothing else: table/action are venue-local
  // vocabulary a binding cannot express portably, and they ride in the payload.
  it('routes on the venue name alone, whatever the frame contains', async () => {
    const cases: [string, string][] = [
      ['trade',       'insert'],
      ['quote',       'partial'],
      ['orderBookL2', 'update'],
      ['instrument',  'delete'],
    ];

    for (const [table, action] of cases) {
      const { service, exchange } = makeService();
      const handler = createMessageHandler(service as any, vi.fn());

      await handler(buf(dataMsg(table, action)), 'bitmex');

      expect(exchange.publish.mock.calls[0][1]).toBe('bitmex');
    }
  });

  it('publishes the original message verbatim as a JSON Buffer', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());
    const msg = dataMsg('quote', 'update');

    await handler(buf(msg), 'bitmex');

    const content = exchange.publish.mock.calls[0][0] as Buffer;

    expect(Buffer.isBuffer(content)).toBe(true);
    expect(JSON.parse(content.toString())).toEqual(msg);
  });

  it('includes x-venue', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(dataMsg()), 'bitmex');

    expect((exchange.publish.mock.calls[0][2] as any).headers['x-venue']).toBe('bitmex');
  });

  it('includes x-hoarder-uuid from config', async () => {
    const { service, config, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(dataMsg()), 'bitmex');

    const headers = (exchange.publish.mock.calls[0][2] as any).headers;

    expect(headers['x-hoarder-uuid']).toBe(config.workerUuid);
  });

  it('includes x-collected-at as a parseable timestamp', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(dataMsg()), 'bitmex');

    const ts = (exchange.publish.mock.calls[0][2] as any).headers['x-collected-at'];

    expect(typeof ts).toBe('string');
    expect(new Date(ts).getTime()).not.toBeNaN();
  });

  // The envelope is deliberately three headers — the dropped ones (version,
  // message count, account id) had no consumer anywhere in the pipeline.
  it('sends exactly the three envelope headers', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(dataMsg()), 'bitmex');

    const headers = (exchange.publish.mock.calls[0][2] as any).headers;

    expect(Object.keys(headers).sort()).toEqual(['x-collected-at', 'x-hoarder-uuid', 'x-venue']);
  });

  it('calls the onMessage callback after each publish', async () => {
    const { service } = makeService();
    const onMessage = vi.fn();
    const handler = createMessageHandler(service as any, onMessage);

    await handler(buf(dataMsg()), 'bitmex');
    await handler(buf(dataMsg()), 'bitmex');

    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it('updates lastMessageTime on every call', async () => {
    const { service, state } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());
    const before = Date.now();

    await handler(buf(dataMsg()), 'bitmex');

    expect(state.lastMessageTime).toBeGreaterThanOrEqual(before);
  });
});

// ── Control messages ──────────────────────────────────────────────────────────

describe('control messages: no publish', () => {
  it('skips publish on subscription confirmation', async () => {
    const { service, exchange } = makeService();
    const onMessage = vi.fn();
    const handler = createMessageHandler(service as any, onMessage);

    await handler(buf({ subscribe: 'trade', success: true }), 'bitmex');

    expect(exchange.publish).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('skips publish on unsubscription confirmation', async () => {
    const { service, exchange } = makeService();
    const onMessage = vi.fn();
    const handler = createMessageHandler(service as any, onMessage);

    await handler(buf({ unsubscribe: 'trade', success: true }), 'bitmex');

    expect(exchange.publish).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('skips publish on info message', async () => {
    const { service, exchange } = makeService();
    const onMessage = vi.fn();
    const handler = createMessageHandler(service as any, onMessage);

    await handler(buf(infoMsg()), 'bitmex');

    expect(exchange.publish).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('skips publish on unrecognized message shapes', async () => {
    const { service, exchange } = makeService();
    const onMessage = vi.fn();
    const handler = createMessageHandler(service as any, onMessage);

    await handler(buf({ unexpected: true, whatever: 123 }), 'bitmex');

    expect(exchange.publish).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });
});

// ── Failure handling ──────────────────────────────────────────────────────────

describe('failure handling', () => {
  it('does not publish on malformed JSON', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(Buffer.from('not json at all'), 'bitmex');

    expect(exchange.publish).not.toHaveBeenCalled();
  });

  it('does not publish for an unknown venue', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(dataMsg()), 'nasdaq');

    expect(exchange.publish).not.toHaveBeenCalled();
  });

  it('rethrows a closed channel so the broker can recover', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    exchange.publish.mockRejectedValueOnce(new Error('Channel closed'));

    await expect(handler(buf(dataMsg()), 'bitmex')).rejects.toThrow('Channel closed');
  });
});
