// Pending Review
import { describe, it, expect } from 'vitest';
import { buildDocumentIdBuffer } from '../src/encoding';
import { encodePriceAndSize, decodePriceAndSize } from '../src/encoding/utils';
import type {
  OrderBookL2Data,
  TradeData,
  QuoteData,
  InstrumentData,
  BitmexAction,
} from '@tradebot/types';
import { encodePayload } from '../src/encoding/encoders';
import { decodeMessage } from '../src/encoding/decoders';
import { QuoteDataAsk, QuoteDataBid } from '../../../shared/types/src';

// ── encodePriceAndSize / decodePriceAndSize ────────────────────────────────────

describe('encodePriceAndSize / decodePriceAndSize', () => {
  const rt = (price: number, size: number) => {
    const enc = encodePriceAndSize(price, size);
    if (enc.meta === 0) return { price: enc.field2 as number, size: enc.field1, raw: true };
    return { ...decodePriceAndSize(enc.field1, enc.meta), raw: false };
  };

  it('positive price and positive size (packed)', () => {
    const { price, size, raw } = rt(45250.5, 1000);
    expect(raw).toBe(false);
    expect(price).toBeCloseTo(45250.5, 4);
    expect(size).toBe(1000);
  });

  it('zero price and zero size (packed, meta encodes 1 priceBytes)', () => {
    const { price, size, raw } = rt(0, 0);
    expect(raw).toBe(false);
    expect(price).toBe(0);
    expect(size).toBe(0);
  });

  it('zero price and positive size', () => {
    const { price, size, raw } = rt(0, 500);
    expect(raw).toBe(false);
    expect(price).toBe(0);
    expect(size).toBe(500);
  });

  it('positive price and zero size (referential)', () => {
    const { price, size, raw } = rt(0.0569, 0);
    expect(raw).toBe(false);
    expect(price).toBeCloseTo(0.0569, 4);
    expect(size).toBe(0);
  });

  it('negative price and positive size', () => {
    const { price, size, raw } = rt(-0.5, 1000);
    expect(raw).toBe(false);
    expect(price).toBeCloseTo(-0.5, 4);
    expect(size).toBe(1000);
  });

  it('negative price and zero size (basis index referential)', () => {
    const { price, size, raw } = rt(-0.000839, 0);
    expect(raw).toBe(false);
    expect(price).toBeCloseTo(-0.000839, 6);
    expect(size).toBe(0);
  });

  it('positive price and negative size', () => {
    const { price, size, raw } = rt(100, -50);
    expect(raw).toBe(false);
    expect(price).toBe(100);
    expect(size).toBe(-50);
  });

  it('both negative', () => {
    const { price, size, raw } = rt(-42.5, -200);
    expect(raw).toBe(false);
    expect(price).toBeCloseTo(-42.5, 4);
    expect(size).toBe(-200);
  });

  it('falls back to raw when too many bits required', () => {
    const enc = encodePriceAndSize(99999.99999, 1000000);
    expect(enc.meta).toBe(0);
    expect(enc.field1).toBe(1000000);  // size stored literally
    expect(enc.field2).toBeCloseTo(99999.99999, 5); // price stored literally
  });
});

/**
 * Encode → build _id → decodeMessage, returning the decoded result.
 */
const roundtrip = (
  items: unknown[],
  table: string,
  action: BitmexAction,
  timestamp: string,
) => {
  const encoded = encodePayload(items as any, table, action);
  const idBuffer = buildDocumentIdBuffer(timestamp, action);
  return decodeMessage(table as any, encoded, idBuffer);
};

// ── OrderBookL2 ────────────────────────────────────────────────────────────────

describe('OrderBookL2 encode → decode', () => {
  const ts = '2024-01-15T10:30:00.000Z';

  it('round-trips an insert with packed data', () => {
    const original: OrderBookL2Data = {
      symbol: 'XBTUSD', id: 12345, side: 'Buy',
      price: 45250.5, size: 1000,
      timestamp: ts, transactTime: ts,
    };

    const { data } = roundtrip([original], 'orderBookL2', 'insert', ts);
    const d = data![0] as OrderBookL2Data;

    expect(d.id).toBe(original.id);
    expect(d.side).toBe(original.side);
    expect(d.symbol).toBe(original.symbol);
    expect(d.price).toBeCloseTo(original.price, 2);
    expect(d.size).toBe(original.size);
  });

  it('round-trips a delete (compact)', () => {
    const original: OrderBookL2Data = {
      symbol: 'XBTUSD', id: 67890, side: 'Sell',
      price: 45300, size: 500,
      timestamp: ts, transactTime: ts,
    };

    const { data } = roundtrip([original], 'orderBookL2', 'delete', ts);
    const d = data![0] as OrderBookL2Data;

    expect(d.id).toBe(original.id);
    expect(d.transactTime).toBe(ts);
    expect(d.symbol).toBe(original.symbol);
  });

  it('handles prices with varying decimal places', () => {
    for (const price of [100, 100.1, 100.123, 100.12345, 0.00001]) {
      const item: OrderBookL2Data = {
        symbol: 'TEST', id: 100, side: 'Buy',
        price, size: 1,
        timestamp: ts, transactTime: ts,
      };

      const { data } = roundtrip([item], 'orderBookL2', 'insert', ts);
      expect((data![0] as OrderBookL2Data).price).toBeCloseTo(price, 5);
    }
  });

  it('groups multiple symbols correctly', () => {
    const items: OrderBookL2Data[] = [
      { symbol: 'XBTUSD', id: 100, side: 'Buy', price: 45250, size: 100, timestamp: ts, transactTime: ts },
      { symbol: 'ETHUSD', id: 200, side: 'Sell', price: 2500.5, size: 500, timestamp: ts, transactTime: ts },
      { symbol: 'XBTUSD', id: 101, side: 'Sell', price: 45251, size: 150, timestamp: ts, transactTime: ts },
    ];

    const { data } = roundtrip(items, 'orderBookL2', 'insert', ts);
    expect(data).toHaveLength(3);

    const symbols = (data as OrderBookL2Data[]).map(d => d.symbol);
    expect(symbols.filter(s => s === 'XBTUSD')).toHaveLength(2);
    expect(symbols.filter(s => s === 'ETHUSD')).toHaveLength(1);
  });

  it('handles large sizes', () => {
    const item: OrderBookL2Data = {
      symbol: 'TEST', id: 2147483647, side: 'Buy',
      price: 999999.99, size: 1000000000,
      timestamp: ts, transactTime: ts,
    };

    const { data } = roundtrip([item], 'orderBookL2', 'insert', ts);
    const d = data![0] as OrderBookL2Data;
    expect(d.id).toBe(item.id);
    expect(d.size).toBe(item.size);
  });
});

// ── Trade ──────────────────────────────────────────────────────────────────────

describe('Trade encode → decode', () => {
  const ts = '2024-01-15T10:30:00.000Z';

  const makeTrade = (overrides: Partial<TradeData> = {}): TradeData => ({
    symbol: 'XBTUSD',
    timestamp: ts,
    trdType: 'Regular',
    trdMatchID: 'match123',
    side: 'Buy',
    size: 500,
    price: 45250.5,
    tickDirection: 'PlusTick',
    grossValue: 5525000,
    homeNotional: 0.5,
    foreignNotional: 5525000,
    ...overrides,
  });

  it('round-trips a regular trade with all optional fields', () => {
    const original = makeTrade();
    const { data } = roundtrip([original], 'trade', 'insert', ts);
    const d = data![0] as TradeData;

    expect(d.symbol).toBe(original.symbol);
    expect(d.timestamp).toBe(ts);
    expect(d.trdMatchID).toBe(original.trdMatchID);
    expect(d.side).toBe(original.side);
    expect(d.size).toBe(original.size);
    expect(d.price).toBeCloseTo(original.price, 2);
    expect(d.tickDirection).toBe(original.tickDirection);
    expect(d.grossValue).toBe(original.grossValue);
    expect(d.homeNotional).toBe(original.homeNotional);
    expect(d.foreignNotional).toBe(original.foreignNotional);
  });

  it('round-trips a trade with no optional fields', () => {
    const original: TradeData = {
      symbol: '.BAI16ZT_NEXT',
      timestamp: ts,
      side: 'Buy',
      size: 0,
      price: 0.0569,
      tickDirection: 'ZeroMinusTick',
      trdType: 'Referential',
    };

    const { data } = roundtrip([original], 'trade', 'insert', ts);
    const d = data![0] as TradeData;

    expect(d.symbol).toBe(original.symbol);
    expect(d.side).toBe('Buy');
    expect(d.size).toBe(0);
    expect(d.price).toBeCloseTo(0.0569, 4);
    expect(d.tickDirection).toBe('ZeroMinusTick');
    expect(d.trdType).toBe('Referential');
    expect(d).not.toHaveProperty('trdMatchID');
    expect(d).not.toHaveProperty('grossValue');
    expect(d).not.toHaveProperty('homeNotional');
    expect(d).not.toHaveProperty('foreignNotional');
    expect(d).not.toHaveProperty('pool');
  });

  it('preserves non-Regular trdType (unknown appended)', () => {
    const original = makeTrade({ trdType: 'Liquidation', trdMatchID: 'liq-001' });
    const { data } = roundtrip([original], 'trade', 'insert', ts);
    const d = data![0] as TradeData;

    expect(d.trdType).toBe('Liquidation');
    expect(d.trdMatchID).toBe('liq-001');
  });

  it('defaults Regular when trdType is Regular', () => {
    const original = makeTrade({ trdType: 'Regular' });
    const { data } = roundtrip([original], 'trade', 'insert', ts);
    expect((data![0] as TradeData).trdType).toBe('Regular');
  });

  it('preserves Referential trdType without appending', () => {
    const original = makeTrade({ trdType: 'Referential' });
    const { data } = roundtrip([original], 'trade', 'insert', ts);
    expect((data![0] as TradeData).trdType).toBe('Referential');
  });

  it('round-trips Sell side', () => {
    const original = makeTrade({ side: 'Sell' });
    const { data } = roundtrip([original], 'trade', 'insert', ts);
    expect((data![0] as TradeData).side).toBe('Sell');
  });

  it('round-trips all tick directions', () => {
    for (const dir of ['MinusTick', 'ZeroMinusTick', 'ZeroPlusTick', 'PlusTick'] as const) {
      const original = makeTrade({ tickDirection: dir });
      const { data } = roundtrip([original], 'trade', 'insert', ts);
      expect((data![0] as TradeData).tickDirection).toBe(dir);
    }
  });

  it('round-trips a trade with pool field', () => {
    const original = makeTrade({ pool: 'main' });
    const { data } = roundtrip([original], 'trade', 'insert', ts);
    expect((data![0] as TradeData).pool).toBe('main');
  });

  it('groups multiple symbols correctly', () => {
    const items: TradeData[] = [
      makeTrade({ symbol: 'XBTUSD', trdMatchID: 'm1' }),
      makeTrade({ symbol: 'ETHUSD', trdMatchID: 'm2', price: 2500.5 }),
      makeTrade({ symbol: 'XBTUSD', trdMatchID: 'm3' }),
    ];

    const { data } = roundtrip(items, 'trade', 'insert', ts);
    expect(data).toHaveLength(3);

    const symbols = (data as TradeData[]).map(d => d.symbol);
    expect(symbols.filter(s => s === 'XBTUSD')).toHaveLength(2);
    expect(symbols.filter(s => s === 'ETHUSD')).toHaveLength(1);
  });

  it('handles prices with varying decimal places', () => {
    for (const price of [100, 100.1, 100.123, 100.12345, 0.00001]) {
      const original = makeTrade({ price });
      const { data } = roundtrip([original], 'trade', 'insert', ts);
      expect((data![0] as TradeData).price).toBeCloseTo(price, 5);
    }
  });

  it('handles large size values', () => {
    const original = makeTrade({ size: 1000000000 });
    const { data } = roundtrip([original], 'trade', 'insert', ts);
    expect((data![0] as TradeData).size).toBe(1000000000);
  });
});

// ── Quote ──────────────────────────────────────────────────────────────────────

describe('Quote encode → decode', () => {
  const ts = '2024-01-15T10:30:00.000Z';

  it('round-trips with both bid and ask', () => {
    const original: QuoteData & QuoteDataBid & QuoteDataAsk = {
      symbol: 'XBTUSD', timestamp: ts,
      bidSize: 100, bidPrice: 45250,
      askPrice: 45251, askSize: 150,
    };

    const { data } = roundtrip([original], 'quote', 'partial', ts);
    const d = data![0] as QuoteData & QuoteDataBid & QuoteDataAsk;

    expect(d.symbol).toBe(original.symbol);
    expect(d.timestamp).toBe(ts);
    expect(d.bidSize).toBe(original.bidSize);
    expect(d.bidPrice).toBeCloseTo(original.bidPrice!, 2);
    expect(d.askPrice).toBeCloseTo(original.askPrice!, 2);
    expect(d.askSize).toBe(original.askSize);
  });

  it('round-trips with bid pair only', () => {
    const original: QuoteData = {
      symbol: 'XBTUSD', timestamp: ts,
      bidSize: 200, bidPrice: 45250.5,
    };

    const { data } = roundtrip([original], 'quote', 'partial', ts);
    const d = data![0] as QuoteData;

    expect(d.bidSize).toBe(200);
    expect(d.bidPrice).toBeCloseTo(45250.5, 2);
    expect(d).not.toHaveProperty('askPrice');
    expect(d).not.toHaveProperty('askSize');
  });

  it('round-trips with ask pair only', () => {
    const original: QuoteData = {
      symbol: 'XBTUSD', timestamp: ts,
      askSize: 300, askPrice: 45251.5,
    };

    const { data } = roundtrip([original], 'quote', 'partial', ts);
    const d = data![0] as QuoteData;

    expect(d.askSize).toBe(300);
    expect(d.askPrice).toBeCloseTo(45251.5, 2);
    expect(d).not.toHaveProperty('bidPrice');
    expect(d).not.toHaveProperty('bidSize');
  });

  it('handles large sizes', () => {
    const original: QuoteData = {
      symbol: 'XBTUSD', timestamp: ts,
      bidSize: 999999, bidPrice: 45250.5,
      askPrice: 45251.5, askSize: 888888,
    };

    const { data } = roundtrip([original], 'quote', 'partial', ts);
    const d = data![0] as QuoteData;
    expect(d.bidSize).toBe(original.bidSize);
    expect(d.askSize).toBe(original.askSize);
  });
});

// ── Instrument ─────────────────────────────────────────────────────────────────

describe('Instrument encode → decode', () => {
  const ts = '2024-01-15T10:30:00.000Z';

  it('round-trips all provided instrument fields', () => {
    const original: InstrumentData = {
      symbol: 'XBTUSD',
      timestamp: ts,
      rootSymbol: 'XBT',
      state: 'Open',
      typ: 'FFCCSX',
      listing: '2014-11-18T00:00:00.000Z',
      tickSize: 1,
      lastPrice: 45250.5,
      bidPrice: 45250,
      askPrice: 45251,
    } as InstrumentData;

    const { data } = roundtrip([original], 'instrument', 'partial', ts);
    const d = data![0] as InstrumentData;

    expect(d).toEqual(original);
  });
});

// ── Metadata ───────────────────────────────────────────────────────────────────

describe('decodeMessage metadata', () => {
  const ts = '2024-01-15T10:30:00.000Z';

  it('recovers table and action from _id', () => {
    const item: OrderBookL2Data = {
      symbol: 'XBTUSD', id: 1, side: 'Buy',
      price: 100, size: 1,
      timestamp: ts, transactTime: ts,
    };

    const result = roundtrip([item], 'orderBookL2', 'insert', ts);
    expect(result.table).toBe('orderBookL2');
    expect(result.action).toBe('insert');
  });

  it('recovers timestamp from _id', () => {
    const item: QuoteData = {
      symbol: 'XBTUSD', timestamp: ts,
      bidSize: 1, bidPrice: 1,
    };

    const { data } = roundtrip([item], 'quote', 'partial', ts);
    expect((data![0] as QuoteData).timestamp).toBe(ts);
  });

  it('throws on unsupported encoder version', () => {
    const encoded = encodePayload(
      [{ symbol: 'T', id: 1, side: 'Buy', price: 1, size: 1, timestamp: ts, transactTime: ts } as OrderBookL2Data],
      'orderBookL2', 'insert',
    );
    const badId = buildDocumentIdBuffer(ts, 'insert', '2.0.0', '2.0.0');

    expect(() => decodeMessage('orderBookL2', encoded, badId)).toThrow(/Unsupported encoder version/);
  });
});

// ── Coverage: untested paths ───────────────────────────────────────────────────

describe('OrderBookL2: update action', () => {
  const ts = '2024-01-15T10:30:00.000Z';

  it('round-trips an update (same encoding as insert)', () => {
    const original: OrderBookL2Data = {
      symbol: 'XBTUSD', id: 55555, side: 'Sell',
      price: 43100.25, size: 750,
      timestamp: ts, transactTime: ts,
    };

    const { data, action } = roundtrip([original], 'orderBookL2', 'update', ts);
    const d = data![0] as OrderBookL2Data;

    expect(action).toBe('update');
    expect(d.id).toBe(original.id);
    expect(d.side).toBe(original.side);
    expect(d.price).toBeCloseTo(original.price, 2);
    expect(d.size).toBe(original.size);
  });
});

describe('Quote: raw fallback paths', () => {
  const ts = '2024-01-15T10:30:00.000Z';

  it('round-trips both pairs when packing exceeds safe int range (4-item raw)', () => {
    // price with many decimals + large size → sizeBits + priceBits > 53 → fallback
    const original: QuoteData = {
      symbol: 'TEST', timestamp: ts,
      bidSize: 1000000, bidPrice: 99999.99999,
      askPrice: 88888.88888, askSize: 2000000,
    };

    const { data } = roundtrip([original], 'quote', 'partial', ts);
    const d = data![0] as QuoteData;

    expect(d.bidPrice).toBeCloseTo(original.bidPrice!, 5);
    expect(d.bidSize).toBe(original.bidSize);
    expect(d.askPrice).toBeCloseTo(original.askPrice!, 5);
    expect(d.askSize).toBe(original.askSize);
  });

  it('round-trips bid-only (packed single pair)', () => {
    const original: QuoteData = {
      symbol: 'TEST', timestamp: ts,
      bidSize: 500, bidPrice: 42000.5,
    };

    const { data } = roundtrip([original], 'quote', 'partial', ts);
    const d = data![0] as QuoteData;

    expect(d.bidPrice).toBeCloseTo(42000.5, 2);
    expect(d.bidSize).toBe(500);
    expect(d).not.toHaveProperty('askPrice');
    expect(d).not.toHaveProperty('askSize');
  });

  it('round-trips ask-only (packed single pair)', () => {
    const original: QuoteData = {
      symbol: 'TEST', timestamp: ts,
      askSize: 800, askPrice: 42001.5,
    };

    const { data } = roundtrip([original], 'quote', 'partial', ts);
    const d = data![0] as QuoteData;

    expect(d.askPrice).toBeCloseTo(42001.5, 2);
    expect(d.askSize).toBe(800);
    expect(d).not.toHaveProperty('bidPrice');
    expect(d).not.toHaveProperty('bidSize');
  });

  it('regression: MONUSDT bid-only with small price and large size', () => {
    // Real sample from production — previously fell through to raw 3-item
    // encoding because the old guard `! bidMeta || ! askMeta` gave up whenever
    // only one pair was present (askMeta was undefined → falsy).
    const original: QuoteData = {
      symbol: 'MONUSDT', timestamp: '2026-02-22T21:47:34.030Z',
      bidSize: 259607800, bidPrice: 0.01931,
    };

    const { data } = roundtrip([original], 'quote', 'insert', original.timestamp);
    const d = data![0] as QuoteData;

    expect(d.symbol).toBe('MONUSDT');
    expect(d.bidPrice).toBeCloseTo(0.01931, 5);
    expect(d.bidSize).toBe(259607800);
    expect(d).not.toHaveProperty('askPrice');
    expect(d).not.toHaveProperty('askSize');
  });
});

describe('Trade: non-standard trdType', () => {
  const ts = '2024-01-15T10:30:00.000Z';

  it('round-trips a trdType not in KNOWN_TRD_TYPES', () => {
    const original: TradeData = {
      symbol: 'XBTUSD', timestamp: ts,
      trdType: 'Settlement',
      trdMatchID: 'settle-001',
      side: 'Buy', size: 100, price: 45000,
      tickDirection: 'PlusTick',
      grossValue: 4500000, homeNotional: 0.01, foreignNotional: 100,
    };

    const { data } = roundtrip([original], 'trade', 'insert', ts);
    const d = data![0] as TradeData;

    expect(d.trdType).toBe('Settlement');
    expect(d.trdMatchID).toBe('settle-001');
    expect(d.side).toBe('Buy');
    expect(d.price).toBe(45000);
    expect(d.size).toBe(100);
    expect(d.grossValue).toBe(4500000);
    expect(d.homeNotional).toBe(0.01);
    expect(d.foreignNotional).toBe(100);
  });
});

// ── Negative price / negative size roundtrips ──────────────────────────────────

describe('OrderBookL2: negative price', () => {
  const ts = '2024-01-15T10:30:00.000Z';

  it('round-trips a negative price (synthetic basis instrument)', () => {
    const original: OrderBookL2Data = {
      symbol: '.BXBT', id: 99999, side: 'Sell',
      price: -0.5, size: 100,
      timestamp: ts, transactTime: ts,
    };

    const { data } = roundtrip([original], 'orderBookL2', 'insert', ts);
    const d = data![0] as OrderBookL2Data;

    expect(d.price).toBeCloseTo(-0.5, 4);
    expect(d.size).toBe(100);
    expect(d.id).toBe(99999);
  });
});

describe('Trade: negative price and zero size', () => {
  const ts = '2026-02-22T02:04:32.000Z';

  it('round-trips referential trade with negative price (real production case)', () => {
    const original: TradeData = {
      symbol: '.AVAXUSDTPT',
      timestamp: ts,
      side: 'Buy',
      size: 0,
      price: -0.000839,
      tickDirection: 'MinusTick',
      trdType: 'Referential',
    };

    const { data } = roundtrip([original], 'trade', 'insert', ts);
    const d = data![0] as TradeData;

    expect(d.symbol).toBe('.AVAXUSDTPT');
    expect(d.trdType).toBe('Referential');
    expect(d.price).toBeCloseTo(-0.000839, 6);
    expect(d.size).toBe(0);
    expect(d.side).toBe('Buy');
    expect(d.tickDirection).toBe('MinusTick');
  });
});

describe('Quote: negative price', () => {
  const ts = '2024-01-15T10:30:00.000Z';

  it('round-trips a negative bid price (synthetic spread instrument)', () => {
    const original: QuoteData = {
      symbol: '.SPREAD', timestamp: ts,
      bidPrice: -0.5, bidSize: 1000,
      askPrice: 0.5, askSize: 500,
    };

    const { data } = roundtrip([original], 'quote', 'insert', ts);
    const d = data![0] as QuoteData;

    expect(d.bidPrice).toBeCloseTo(-0.5, 4);
    expect(d.bidSize).toBe(1000);
    expect(d.askPrice).toBeCloseTo(0.5, 4);
    expect(d.askSize).toBe(500);
  });

  it('round-trips a negative ask price only', () => {
    const original: QuoteData = {
      symbol: '.SPREAD', timestamp: ts,
      askPrice: -0.25, askSize: 200,
    };

    const { data } = roundtrip([original], 'quote', 'insert', ts);
    const d = data![0] as QuoteData;

    expect(d.askPrice).toBeCloseTo(-0.25, 4);
    expect(d.askSize).toBe(200);
    expect(d).not.toHaveProperty('bidPrice');
  });
});
