// Pending Review
import { describe, it, expect } from 'vitest';
import { buildDocumentId } from '../src/encoding';
import { encodePayload } from '../src/encoding/encoders';
import { decodeMessage } from '../src/encoding/decoders';
import type { OrderBookL2Data, TradeData, QuoteData, InstrumentData, BitmexAction } from '@tradebot/types';
import { QuoteDataAsk, QuoteDataBid } from '../../../shared/types/src';

const roundtrip = (items: unknown[], table: string, action: BitmexAction, timestamp: string) => {
  const encoded = encodePayload(items as any, table, action);
  return decodeMessage(table as any, encoded, buildDocumentId(timestamp, action));
};

// ── Fixture data ───────────────────────────────────────────────────────────────

const orderBookL2Fixtures: OrderBookL2Data[] = [
  { symbol: 'XBTUSD', id: 1234567, side: 'Buy', price: 42500.5, size: 100, timestamp: '2024-02-15T10:30:00.000Z', transactTime: '2024-02-15T10:30:00.000Z' },
  { symbol: 'ETHUSD', id: 7654321, side: 'Sell', price: 2450.75, size: 500, timestamp: '2024-02-15T10:30:01.000Z', transactTime: '2024-02-15T10:30:01.000Z' },
  { symbol: 'XBTUSD', id: 9999, side: 'Buy', price: 0.00001, size: 1000000, timestamp: '2024-02-15T10:30:02.000Z', transactTime: '2024-02-15T10:30:02.000Z', pool: 'main' },
  { symbol: 'LINKUSD', id: 8888888, side: 'Sell', price: 28.12345, size: 1, timestamp: '2024-02-15T10:30:03.000Z', transactTime: '2024-02-15T10:30:03.000Z' },
];

const tradeFixtures: TradeData[] = [
  { symbol: 'XBTUSD', timestamp: '2024-02-15T10:30:00.000Z', trdType: 'Regular', trdMatchID: 'match-001', side: 'Buy', size: 100, price: 42500, tickDirection: 'PlusTick', grossValue: 4250000, homeNotional: 0.01, foreignNotional: 100 },
  { symbol: 'ETHUSD', timestamp: '2024-02-15T10:30:01.000Z', trdType: 'Regular', trdMatchID: 'match-002', side: 'Sell', size: 1000, price: 2400.5, tickDirection: 'MinusTick', grossValue: 2400500, homeNotional: 0.416, foreignNotional: 1000 },
];

const quoteFixtures: (QuoteData & QuoteDataBid & QuoteDataAsk)[] = [
  { symbol: 'XBTUSD', timestamp: '2024-02-15T10:30:00.000Z', bidSize: 10000, bidPrice: 42499.5, askPrice: 42500.5, askSize: 15000 },
  { symbol: 'ETHUSD', timestamp: '2024-02-15T10:30:01.000Z', bidSize: 50000, bidPrice: 2400, askPrice: 2401, askSize: 75000 },
  { symbol: 'XBTUSD', timestamp: '2024-02-15T10:30:02.000Z', bidSize: 1, bidPrice: 0.00001, askPrice: 100000.99999, askSize: 999999 },
];

const instrumentFixtures: InstrumentData[] = [
  { symbol: 'XBTUSD', rootSymbol: 'XBT', state: 'Open', typ: 'FFCCSX', listing: '2014-11-18T00:00:00.000Z', settle: '2099-12-31T00:00:00.000Z', tickSize: 1, lotSize: 100, multiplier: 100000000, lastPrice: 42500.5, bidPrice: 42499.5, askPrice: 42501.5, fundingRate: 0.0001, timestamp: '2024-02-15T10:30:00.000Z' } as InstrumentData,
  { symbol: 'ETHUSD', rootSymbol: 'ETH', state: 'Open', typ: 'FFCCSX', listing: '2018-05-16T00:00:00.000Z', settle: '2099-12-31T00:00:00.000Z', tickSize: 1, lotSize: 1, multiplier: 1000000, lastPrice: 2400.5, bidPrice: 2400, askPrice: 2401, fundingRate: 0.00005, timestamp: '2024-02-15T10:30:01.000Z' } as InstrumentData,
];

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Fixture round-trips', () => {
  describe('orderBookL2', () => {
    it('round-trips insert actions for all fixtures', () => {
      for (const fixture of orderBookL2Fixtures) {
        const { data } = roundtrip([fixture], 'orderBookL2', 'insert', fixture.timestamp);
        const d = data![0] as OrderBookL2Data;

        expect(d.id).toBe(fixture.id);
        expect(d.side).toBe(fixture.side);
        expect(d.symbol).toBe(fixture.symbol);
        expect(d.price).toBeCloseTo(fixture.price, 5);
        expect(d.size).toBe(fixture.size);
      }
    });

    it('round-trips delete actions preserving id and transactTime', () => {
      for (const fixture of orderBookL2Fixtures) {
        const { data } = roundtrip([fixture], 'orderBookL2', 'delete', fixture.timestamp);
        const d = data![0] as OrderBookL2Data;

        expect(d.id).toBe(fixture.id);
        expect(d.transactTime).toBe(fixture.transactTime);
        expect(d.symbol).toBe(fixture.symbol);
      }
    });

    it('groups multi-symbol encoding', () => {
      const items = [
        orderBookL2Fixtures[0],
        orderBookL2Fixtures[1],
        { ...orderBookL2Fixtures[0], id: 111 },
      ];

      const { data } = roundtrip(items, 'orderBookL2', 'insert', items[0].timestamp);
      expect(data).toHaveLength(3);
    });
  });

  describe('trade', () => {
    it('round-trips all trade fixtures', () => {
      for (const fixture of tradeFixtures) {
        const { data } = roundtrip([fixture], 'trade', 'insert', fixture.timestamp);
        const d = data![0] as TradeData;

        expect(d.symbol).toBe(fixture.symbol);
        expect(d.trdMatchID).toBe(fixture.trdMatchID);
        expect(d.side).toBe(fixture.side);
        expect(d.size).toBe(fixture.size);
        expect(d.price).toBeCloseTo(fixture.price, 2);
        expect(d.tickDirection).toBe(fixture.tickDirection);
        expect(d.grossValue).toBe(fixture.grossValue);
      }
    });
  });

  describe('quote', () => {
    it('round-trips all quote fixtures', () => {
      for (const fixture of quoteFixtures) {
        const { data } = roundtrip([fixture], 'quote', 'partial', fixture.timestamp);
        const d = data![0] as QuoteData & QuoteDataBid & QuoteDataAsk;

        expect(d.symbol).toBe(fixture.symbol);
        expect(d.bidSize).toBe(fixture.bidSize);
        expect(d.bidPrice).toBeCloseTo(fixture.bidPrice!, 5);
        expect(d.askPrice).toBeCloseTo(fixture.askPrice!, 5);
        expect(d.askSize).toBe(fixture.askSize);
      }
    });
  });

  describe('instrument', () => {
    it('round-trips instrument fixtures', () => {
      for (const fixture of instrumentFixtures) {
        const { data } = roundtrip([fixture], 'instrument', 'partial', fixture.timestamp!);
        const d = data![0] as InstrumentData;

        expect(d.symbol).toBe(fixture.symbol);
        expect(d.rootSymbol).toBe(fixture.rootSymbol);
        expect(d.state).toBe(fixture.state);
        expect(d.typ).toBe(fixture.typ);
        expect(d.tickSize).toBe(fixture.tickSize);
        expect(d.multiplier).toBe(fixture.multiplier);
      }
    });
  });
});
