import { vi, describe, it, expect, beforeEach } from 'vitest';
import { createMessageHandler } from '../src/messages';
import type { Config, FeedState } from '../src/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WORKER_UUID = '11111111-2222-3333-4444-555555555555';

const makeConfig = (): Config => ({
  env: 'testnet',
  workerUuid: WORKER_UUID,
  realtimeWsUrl: 'wss://testnet.bitmex.com/realtime',
  platformWsUrl: 'wss://testnet.bitmex.com/realtimePlatform',
  realtimeChannels: [],
  platformChannels: [],
  queue: { rabbitmqUrl: 'amqp://localhost', messageTtlMs: 1000 },
  connection: { reconnectDelayMs: 1000, maxReconnectDelayMs: 60000 },
});

const makeState = (publishFn = vi.fn()): FeedState => ({
  realtime: null,
  platform: null,
  broker: {
    getExchange: () => ({ publish: publishFn }),
  } as any,
  reconnectDelay: 1000,
  isShuttingDown: false,
  lastMessageTime: 0,
  apiVersion: null,
  pingInterval: null,
});

const dataMessage = (table: string, action: string, data = [{ symbol: 'XBTUSD', bidSize: 100 }]) =>
  Buffer.from(JSON.stringify({ table, action, data }));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createMessageHandler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('publishes with correct headers on a data message', () => {
    const publish = vi.fn();
    const handler = createMessageHandler(makeState(publish), makeConfig());

    handler(dataMessage('quote', 'insert'));

    expect(publish).toHaveBeenCalledOnce();
    const [, , options] = publish.mock.calls[0];
    expect(options.headers['x-bitmex-published-at']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(options.headers['x-worker-uuid']).toBe(WORKER_UUID);
  });

  it('uses routing key table.action.symbol for single-symbol messages', () => {
    const publish = vi.fn();
    const handler = createMessageHandler(makeState(publish), makeConfig());

    handler(dataMessage('quote', 'insert'));

    const [, routingKey] = publish.mock.calls[0];
    expect(routingKey).toBe('quote.insert.XBTUSD');
  });

  it('uses empty symbol segment for tables without symbol', () => {
    const publish = vi.fn();
    const handler = createMessageHandler(makeState(publish), makeConfig());

    handler(dataMessage('announcement', 'insert', [{ id: 1, title: 'Test', link: '', content: '', date: '' }]));

    const [, routingKey] = publish.mock.calls[0];
    expect(routingKey).toBe('announcement.insert.');
  });

  it('uses the symbol when all data items share the same symbol', () => {
    const publish = vi.fn();
    const handler = createMessageHandler(makeState(publish), makeConfig());

    handler(dataMessage('orderBookL2', 'update', [
      { symbol: 'XBTUSD', id: 1, side: 'Buy', price: 100, size: 10 },
      { symbol: 'XBTUSD', id: 2, side: 'Sell', price: 101, size: 5 },
    ]));

    const [, routingKey] = publish.mock.calls[0];
    expect(routingKey).toBe('orderBookL2.update.XBTUSD');
  });

  it('uses empty symbol segment for multi-symbol messages', () => {
    const publish = vi.fn();
    const handler = createMessageHandler(makeState(publish), makeConfig());

    handler(dataMessage('trade', 'insert', [
      { symbol: 'XBTUSD', price: 100, size: 1 },
      { symbol: 'ETHUSD', price: 200, size: 1 },
    ]));

    const [, routingKey] = publish.mock.calls[0];
    expect(routingKey).toBe('trade.insert.');
  });

  it('does not publish control messages', () => {
    const publish = vi.fn();
    const handler = createMessageHandler(makeState(publish), makeConfig());

    handler(Buffer.from(JSON.stringify({ info: 'Welcome', version: '2.0.0' })));

    expect(publish).not.toHaveBeenCalled();
  });

  it('does not throw on malformed JSON', () => {
    const handler = createMessageHandler(makeState(), makeConfig());
    expect(() => handler(Buffer.from('{bad json'))).not.toThrow();
  });
});
