import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@devvir/service-kit';
import { createMessageHandler } from '../src/messages';
import type { State, Config } from '../src/types';

// The relay is tried against a venue of the tests' own — see ./twin.
vi.mock('../src/venues', async importOriginal => (await import('./twin')).withTwin(importOriginal as never));

// ── Service mock ──────────────────────────────────────────────────────────────

const makeService = (stateOverrides: Partial<State> = {}) => {
  const state: State = {
    broker:         null,
    isShuttingDown: false,
    ...stateOverrides,
  };

  const config: Config = {
    workerUuid:  'test-uuid-1234',
    rabbitmqUrl: 'amqp://localhost',
    venues:      ['twin'],
  };

  const exchange = { publish: vi.fn().mockResolvedValue(undefined) };
  const broker   = { getExchange: vi.fn(() => exchange) };

  const service = {
    state:     (key?: string) => (key !== undefined ? (state as Record<string, unknown>)[key] : state),
    setState:  (key: string, value: unknown) => { (state as Record<string, unknown>)[key] = value; return value; },
    config:    () => config,
    providers: { get: vi.fn(() => broker) },
    shutdown:  vi.fn().mockResolvedValue(undefined),
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
  info:      'Welcome to the Realtime API.',
  version,
  timestamp: '2026-01-01T00:00:00.000Z',
  docs:      'https://twin.test/docs',
});

/** amqplib's error for a publish on a closed channel. */
const channelClosed = (): Error => Object.assign(new Error('Channel closed'), { name: 'IllegalOperationError' });

// ── Publishing ────────────────────────────────────────────────────────────────

describe('data messages: publishing', () => {
  it('publishes to the exchange for every data message', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(dataMsg()), 'twin');

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

      await handler(buf(dataMsg(table, action)), 'twin');

      expect(exchange.publish.mock.calls[0][1]).toBe('twin');
    }
  });

  // Number text, escapes and whitespace are all things a parse/serialise round
  // trip would change; the archive must hold the bytes the venue sent.
  it('publishes the received bytes unchanged', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());
    const raw = String.raw`{ "table" : "trade",  "action":"insert",
      "data":[{"qty":0.10000000,"price":45283.50,"fee":1e-8,"id":12345678901234567890,"note":"caf\u00e9"}] }`;
    const buffer = Buffer.from(raw);

    await handler(buffer, 'twin');

    const content = exchange.publish.mock.calls[0][0] as Buffer;

    expect(Buffer.isBuffer(content)).toBe(true);
    expect(content.equals(Buffer.from(raw))).toBe(true);
  });

  it('includes x-venue', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(dataMsg()), 'twin');

    expect((exchange.publish.mock.calls[0][2] as any).headers['x-venue']).toBe('twin');
  });

  it('includes x-hoarder-uuid from config', async () => {
    const { service, config, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(dataMsg()), 'twin');

    const headers = (exchange.publish.mock.calls[0][2] as any).headers;

    expect(headers['x-hoarder-uuid']).toBe(config.workerUuid);
  });

  it('includes x-collected-at as a parseable timestamp', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(dataMsg()), 'twin');

    const ts = (exchange.publish.mock.calls[0][2] as any).headers['x-collected-at'];

    expect(typeof ts).toBe('string');
    expect(new Date(ts).getTime()).not.toBeNaN();
  });

  // The envelope is deliberately three headers — the dropped ones (version,
  // message count, account id) had no consumer anywhere in the pipeline.
  it('sends exactly the three envelope headers', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(dataMsg()), 'twin');

    const headers = (exchange.publish.mock.calls[0][2] as any).headers;

    expect(Object.keys(headers).sort()).toEqual(['x-collected-at', 'x-hoarder-uuid', 'x-venue']);
  });

  it('calls the onMessage callback after each publish', async () => {
    const { service } = makeService();
    const onMessage = vi.fn();
    const handler = createMessageHandler(service as any, onMessage);

    await handler(buf(dataMsg()), 'twin');
    await handler(buf(dataMsg()), 'twin');

    expect(onMessage).toHaveBeenCalledTimes(2);
  });
});

// ── Control messages ──────────────────────────────────────────────────────────

describe('control messages: no publish', () => {
  it('skips publish on subscription confirmation', async () => {
    const { service, exchange } = makeService();
    const onMessage = vi.fn();
    const handler = createMessageHandler(service as any, onMessage);

    await handler(buf({ subscribe: 'trade', success: true }), 'twin');

    expect(exchange.publish).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('skips publish on unsubscription confirmation', async () => {
    const { service, exchange } = makeService();
    const onMessage = vi.fn();
    const handler = createMessageHandler(service as any, onMessage);

    await handler(buf({ unsubscribe: 'trade', success: true }), 'twin');

    expect(exchange.publish).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('skips publish on info message', async () => {
    const { service, exchange } = makeService();
    const onMessage = vi.fn();
    const handler = createMessageHandler(service as any, onMessage);

    await handler(buf(infoMsg()), 'twin');

    expect(exchange.publish).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('skips publish on unrecognized message shapes', async () => {
    const { service, exchange } = makeService();
    const onMessage = vi.fn();
    const handler = createMessageHandler(service as any, onMessage);

    await handler(buf({ unexpected: true, whatever: 123 }), 'twin');

    expect(exchange.publish).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });
});

// ── Failure handling ──────────────────────────────────────────────────────────

describe('failure handling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not publish on malformed JSON', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(Buffer.from('not json at all'), 'twin');

    expect(exchange.publish).not.toHaveBeenCalled();
  });

  it('does not publish for an unknown venue', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(dataMsg()), 'nasdaq');

    expect(exchange.publish).not.toHaveBeenCalled();
  });

  it('logs a failed publish and goes on relaying', async () => {
    const { service, exchange } = makeService();
    const onMessage = vi.fn();
    const handler = createMessageHandler(service as any, onMessage);

    exchange.publish.mockRejectedValueOnce(new Error('boom'));

    await expect(handler(buf(dataMsg()), 'twin')).resolves.toBeUndefined();
    await handler(buf(dataMsg()), 'twin');

    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ venue: 'twin' }), 'Error processing WebSocket message');
    expect(onMessage).toHaveBeenCalledOnce();
    expect(service.shutdown).not.toHaveBeenCalled();
  });

  // Nothing reconnects the broker's channel, so a lost one ends the process and
  // the container restart connects again.
  it('shuts the service down once when the broker channel is lost', async () => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    exchange.publish.mockRejectedValue(channelClosed());

    for (let i = 0; i < 3; i++)
      await expect(handler(buf(dataMsg()), 'twin')).resolves.toBeUndefined();

    expect(service.shutdown).toHaveBeenCalledOnce();
    expect(service.shutdown).toHaveBeenCalledWith('RABBITMQ_LOST');
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('drops frames silently while shutting down', async () => {
    const { service, exchange } = makeService({ isShuttingDown: true });
    const handler = createMessageHandler(service as any, vi.fn());

    exchange.publish.mockRejectedValue(channelClosed());

    await expect(handler(buf(dataMsg()), 'twin')).resolves.toBeUndefined();

    expect(service.shutdown).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

// ── Control frame logging ─────────────────────────────────────────────────────

describe('control messages: logging', () => {
  beforeEach(() => vi.clearAllMocks());

  // Captured refusals, one per venue: each is a request the venue turned down.
  const refusals: [string, unknown][] = [
    ['binance', { error: { code: 2, msg: 'Invalid request: unknown stream' }, id: 'btcusdt-nonsense' }],
    ['bybit',   { success: false, ret_msg: 'error:handler not found,topic:nonsense.BTCUSDT', req_id: 'nonsense.BTCUSDT', op: 'subscribe' }],
    ['kraken',  { error: 'Subscription name invalid', method: 'subscribe', success: false }],
    ['okx',     { event: 'error', msg: 'Wrong URL or channel:nonsense,instId:BTC-USDT', code: '60018' }],
    ['twin',    { subscribe: 'nonsense', success: false }],
  ];

  it.each(refusals)('logs a %s refusal at warn', async (venue, frame) => {
    const { service, exchange } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(frame), venue);

    expect(exchange.publish).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith({ venue }, expect.any(String));
    expect(logger.debug).not.toHaveBeenCalled();
  });

  const acks: [string, unknown][] = [
    ['binance', { result: null, id: 'btcusdt-aggTrade' }],
    ['bybit',   { success: true, ret_msg: '', req_id: 'publicTrade.BTCUSDT', op: 'subscribe' }],
    ['kraken',  { method: 'subscribe', result: { channel: 'trade', symbol: 'BTC/USD' }, success: true }],
    ['okx',     { event: 'subscribe', arg: { channel: 'trades', instId: 'BTC-USDT' } }],
    ['twin',    { subscribe: 'trade', success: true }],
  ];

  it.each(acks)('logs a %s ack at debug', async (venue, frame) => {
    const { service } = makeService();
    const handler = createMessageHandler(service as any, vi.fn());

    await handler(buf(frame), venue);

    expect(logger.debug).toHaveBeenCalledWith({ venue }, expect.any(String));
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
