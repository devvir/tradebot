import { describe, it, expect } from 'vitest';
import transform from '../src/encoding/transform';
import type {
  TradeData,
  QuoteDataFull,
  OrderBookL2Data,
  InstrumentData,
} from '@tradebot/types';
import type { Message } from '../src/types';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Minimal RawMessage stub — only properties.headers matters to transform. */
const rawMsg = (strategy?: 'encode' | 'decode') => ({
  properties: {
    headers: strategy ? { 'x-codec-strategy': strategy } : {},
  },
} as any);

/** Simulate the JSON round-trip that happens when a message passes through RabbitMQ. */
const via = (buf: Buffer): unknown => JSON.parse(buf.toString('utf-8'));

// ── Encode strategy ────────────────────────────────────────────────────────────

describe('encode strategy', () => {
  it('returns a Buffer with a compressed b field and no data field', () => {
    const msg: Message = {
      table: 'trade',
      action: 'insert',
      data: [{
        symbol: 'XBTUSD', timestamp: '2026-02-15T10:30:00.000Z',
        trdType: 'Regular', trdMatchID: 'match-001', side: 'Buy',
        size: 100, price: 42500, tickDirection: 'PlusTick',
        grossValue: 4250000, homeNotional: 0.01, foreignNotional: 100,
      } as TradeData],
    };

    const result = transform(rawMsg('encode'), msg);

    expect(Buffer.isBuffer(result)).toBe(true);
    const parsed = via(result) as any;
    expect(parsed.table).toBe('trade');
    expect(parsed.action).toBe('insert');
    expect(parsed.b).toBeDefined();
    expect(parsed.data).toBeUndefined();
  });

  it('defaults to encode when x-codec-strategy header is absent', () => {
    const msg: Message = {
      table: 'quote', action: 'insert',
      data: [{ symbol: 'XBTUSD', timestamp: '2026-02-15T10:30:00.000Z', bidSize: 100, bidPrice: 42500, askPrice: 42501, askSize: 200 } as QuoteDataFull],
    };

    const parsed = via(transform(rawMsg(), msg)) as any;
    expect(parsed.b).toBeDefined();
    expect(parsed.data).toBeUndefined();
  });
});

// ── Decode strategy ────────────────────────────────────────────────────────────

describe('decode strategy', () => {
  it('passes through a message without b unchanged', () => {
    const msg: Message = {
      table: 'trade', action: 'insert',
      data: [{ symbol: 'XBTUSD' }] as any,
    };

    const parsed = via(transform(rawMsg('decode'), msg)) as any;
    expect(parsed.data).toBeDefined();
    expect(parsed.b).toBeUndefined();
  });
});

// ── Encode → Decode roundtrip ──────────────────────────────────────────────────

const roundtrip = (msg: Message): any => {
  const encoded = via(transform(rawMsg('encode'), msg)) as Message;
  return via(transform(rawMsg('decode'), encoded)) as any;
};

describe('encode → decode roundtrip', () => {
  it('round-trips trade data', () => {
    const trade: TradeData = {
      symbol: 'XBTUSD', timestamp: '2026-02-15T10:30:00.000Z',
      trdType: 'Regular', trdMatchID: 'match-001', side: 'Buy',
      size: 100, price: 42500, tickDirection: 'PlusTick',
      grossValue: 4250000, homeNotional: 0.01, foreignNotional: 100,
    };

    const decoded = roundtrip({ table: 'trade', action: 'insert', data: [trade] });

    expect(decoded.table).toBe('trade');
    expect(decoded.action).toBe('insert');
    expect(decoded.data[0].symbol).toBe(trade.symbol);
    expect(decoded.data[0].trdMatchID).toBe(trade.trdMatchID);
    expect(decoded.data[0].side).toBe(trade.side);
    expect(decoded.data[0].size).toBe(trade.size);
    expect(decoded.data[0].price).toBeCloseTo(trade.price, 2);
    expect(decoded.data[0].tickDirection).toBe(trade.tickDirection);
    expect(decoded.data[0].grossValue).toBe(trade.grossValue);
  });

  it('round-trips trade with minimal fields (no optional fields)', () => {
    const trade: TradeData = {
      symbol: '.AVAXUSDTPT', timestamp: '2026-02-15T10:30:00.000Z',
      side: 'Buy', size: 0, price: -0.000839,
      tickDirection: 'MinusTick', trdType: 'Referential',
    };

    const decoded = roundtrip({ table: 'trade', action: 'insert', data: [trade] });

    expect(decoded.data[0].symbol).toBe(trade.symbol);
    expect(decoded.data[0].price).toBeCloseTo(trade.price, 6);
    expect(decoded.data[0].size).toBe(0);
    expect(decoded.data[0].trdType).toBe('Referential');
    expect(decoded.data[0].trdMatchID).toBeUndefined();
  });

  it('round-trips multiple trades from different symbols', () => {
    const items: TradeData[] = [
      { symbol: 'XBTUSD', timestamp: '2026-02-15T10:30:00.000Z', trdType: 'Regular', trdMatchID: 'm1', side: 'Buy', size: 100, price: 42500, tickDirection: 'PlusTick', grossValue: 4250000, homeNotional: 0.01, foreignNotional: 100 },
      { symbol: 'ETHUSD', timestamp: '2026-02-15T10:30:01.000Z', trdType: 'Regular', trdMatchID: 'm2', side: 'Sell', size: 1000, price: 2400.5, tickDirection: 'MinusTick', grossValue: 2400500, homeNotional: 0.416, foreignNotional: 1000 },
    ];

    const decoded = roundtrip({ table: 'trade', action: 'insert', data: items });

    expect(decoded.data).toHaveLength(2);
    expect(decoded.data.map((d: any) => d.symbol).sort()).toEqual(['ETHUSD', 'XBTUSD']);
  });

  it('round-trips quote data', () => {
    const quote: QuoteDataFull = {
      symbol: 'XBTUSD', timestamp: '2026-02-15T10:30:00.000Z',
      bidSize: 10000, bidPrice: 42499.5, askPrice: 42500.5, askSize: 15000,
    };

    const decoded = roundtrip({ table: 'quote', action: 'partial', data: [quote] } as any);

    expect(decoded.data[0].symbol).toBe(quote.symbol);
    expect(decoded.data[0].timestamp).toBe(quote.timestamp);
    expect(decoded.data[0].bidSize).toBe(quote.bidSize);
    expect(decoded.data[0].bidPrice).toBeCloseTo(quote.bidPrice, 2);
    expect(decoded.data[0].askPrice).toBeCloseTo(quote.askPrice, 2);
    expect(decoded.data[0].askSize).toBe(quote.askSize);
  });

  it('round-trips bid-only quote', () => {
    const quote = { symbol: 'XBTUSD', timestamp: '2026-02-15T10:30:00.000Z', bidSize: 200, bidPrice: 42499.5 } as QuoteDataFull;

    const decoded = roundtrip({ table: 'quote', action: 'partial', data: [quote] } as any);

    expect(decoded.data[0].bidSize).toBe(200);
    expect(decoded.data[0].bidPrice).toBeCloseTo(42499.5, 2);
    expect(decoded.data[0]).not.toHaveProperty('askPrice');
    expect(decoded.data[0]).not.toHaveProperty('askSize');
  });

  it('round-trips orderBookL2 data', () => {
    const item: OrderBookL2Data = {
      symbol: 'XBTUSD', id: 12345, side: 'Buy',
      price: 42500.5, size: 100,
      timestamp: '2026-02-15T10:30:00.948Z', transactTime: '2026-02-15T10:30:00.000Z',
    };

    const decoded = roundtrip({ table: 'orderBookL2', action: 'insert', data: [item] });

    expect(decoded.data[0].id).toBe(item.id);
    expect(decoded.data[0].side).toBe(item.side);
    expect(decoded.data[0].symbol).toBe(item.symbol);
    expect(decoded.data[0].price).toBeCloseTo(item.price, 2);
    expect(decoded.data[0].size).toBe(item.size);
    expect(decoded.data[0].timestamp).toBe(item.timestamp);
    expect(decoded.data[0].transactTime).toBe(item.transactTime);
  });

  it('round-trips orderBookL2 delete (compact form)', () => {
    const item: OrderBookL2Data = {
      symbol: 'XBTUSD', id: 67890, side: 'Sell',
      price: 45300, size: 500,
      timestamp: '2024-01-15T10:30:00.948Z', transactTime: '2024-01-15T10:30:00.000Z',
    };

    const decoded = roundtrip({ table: 'orderBookL2', action: 'delete', data: [item] });

    expect(decoded.data[0].id).toBe(item.id);
    expect(decoded.data[0].symbol).toBe(item.symbol);
    expect(decoded.data[0].timestamp).toBe(item.timestamp);
    expect(decoded.data[0].transactTime).toBe(item.transactTime);
  });

  it('round-trips instrument data', () => {
    const item = {
      symbol: 'XBTUSD', timestamp: '2026-02-15T10:30:00.000Z',
      lastPrice: 42500.5, bidPrice: 42499.5, askPrice: 42501.5,
      rootSymbol: 'XBT', state: 'Open', typ: 'FFCCSX', tickSize: 1,
    } as InstrumentData;

    const decoded = roundtrip({ table: 'instrument', action: 'partial', data: [item] } as any);

    expect(decoded.data[0].symbol).toBe(item.symbol);
    expect(decoded.data[0].lastPrice).toBeCloseTo(item.lastPrice!, 2);
    expect(decoded.data[0].rootSymbol).toBe(item.rootSymbol);
    expect(decoded.data[0].state).toBe(item.state);
  });
});
