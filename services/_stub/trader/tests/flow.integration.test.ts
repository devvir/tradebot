/**
 * Integration tests across the trader: strategy → planner → cache → orchestrator.
 *
 * The converge algorithm itself is exercised in depth in converge.test.ts;
 * this file proves the pieces wire together correctly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DataCache } from '../src/source';
import { RangeStrategy } from '../src/strategies';
import { STRATEGIES } from '../src/strategies';
import { translateOrders } from '../src/planner';
import { roundToTick, roundToLot } from '../src/planner/rounding';
import { Orchestrator } from '../src/core';
import type { StrategyConfig } from '../src/core';
import type { RestClient } from '../src/rest';
import type { Quote, Order, Instrument } from '../src/types';
import type { OrderPlan } from '../src/planner/types';

// ---- Fixtures ---------------------------------------------------------

const quote: Quote = {
  symbol:    'XBTUSD',
  timestamp: '2026-04-29T00:00:00Z',
  bidPrice:  1000,
  bidSize:   10,
  askPrice:  1002,
  askSize:   10,
};

const instrument: Instrument = {
  symbol:     'XBTUSD',
  markPrice:  1001,
  tickSize:   0.5,
  lotSize:    100,
  multiplier: 1,
};

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    orderID:   `order-${Math.random()}`,
    clOrdID:   'tb_XBTUSD_000001',
    symbol:    'XBTUSD',
    side:      'Buy',
    price:     990,
    orderQty:  100,
    leavesQty: 100,
    ordStatus: 'New',
    timestamp: '2026-04-29T00:00:00Z',
    ...overrides,
  };
}

function makeMockClient(): RestClient {
  return {
    createOrder: vi.fn(async (order: OrderPlan, clOrdID: string) => makeOrder({
      clOrdID,
      side:     order.side,
      price:    order.price ?? 990,
      orderQty: order.orderQty ?? 100,
    })),
    amendOrder:   vi.fn(async () => makeOrder()),
    cancelOrders: vi.fn(async () => {}),
    getOrders:    vi.fn(async () => []),
  };
}

function makeConfig(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return {
    ...STRATEGIES['range']!.defaults,
    symbol:         'XBTUSD',
    tickIntervalMs: 99_999,
    ...overrides,
  };
}

// ---- RangeStrategy ----------------------------------------------------

describe('RangeStrategy', () => {
  it('returns empty when there is no quote', () => {
    const strategy = new RangeStrategy();
    const result   = strategy.decide({ quote: null, orders: [], position: null, instrument: null });

    expect(result).toHaveLength(0);
  });

  it('places a buy and a sell 1% from mid', () => {
    const strategy = new RangeStrategy();
    const result   = strategy.decide({ quote, orders: [], position: null, instrument: null });

    // mid = (1000 + 1002) / 2 = 1001
    const mid = 1001;

    expect(result).toHaveLength(2);
    expect(result[0]?.side).toBe('buy');
    expect(result[1]?.side).toBe('sell');
    expect(result[0]?.price).toBeCloseTo(mid * 0.99, 4);
    expect(result[1]?.price).toBeCloseTo(mid * 1.01, 4);
  });
});

// ---- Planner (rounding + translation) ---------------------------------

describe('Planner — rounding', () => {
  it('rounds price to the nearest tick', () => {
    expect(roundToTick(1001.3, 0.5)).toBe(1001.5);
    expect(roundToTick(1001.1, 0.5)).toBe(1001);
  });

  it('rounds quantity down to a lot multiple', () => {
    expect(roundToLot(150, 100)).toBe(100);
    expect(roundToLot(200, 100)).toBe(200);
    expect(roundToLot(99, 100)).toBe(0);
  });

  it('is a no-op when tickSize is 0', () => {
    expect(roundToTick(1234.56, 0)).toBe(1234.56);
  });
});

describe('Planner — translateOrders', () => {
  it('translates a buy pseudo-order to a BitMEX OrderPlan', () => {
    const pseudo   = [{ side: 'buy' as const, price: 990.99, quantity: 100 }];
    const [result] = translateOrders(pseudo, 'XBTUSD', instrument);

    expect(result?.symbol).toBe('XBTUSD');
    expect(result?.side).toBe('Buy');
    // 990.99 rounded to nearest 0.5 tick = 991
    expect(result?.price).toBe(991);
    expect(result?.orderQty).toBe(100);
  });

  it('defaults the quantity to 100 when not supplied', () => {
    const pseudo   = [{ side: 'sell' as const, price: 1010 }];
    const [result] = translateOrders(pseudo, 'XBTUSD', instrument);

    expect(result?.orderQty).toBe(100);
  });

  it('does not round when no instrument is available', () => {
    const pseudo   = [{ side: 'buy' as const, price: 990.99, quantity: 150 }];
    const [result] = translateOrders(pseudo, 'XBTUSD', null);

    expect(result?.price).toBe(990.99);
    expect(result?.orderQty).toBe(150);
  });
});

// ---- DataCache --------------------------------------------------------

describe('DataCache', () => {
  it('stores and retrieves a quote', () => {
    const cache = new DataCache();
    cache.updateQuote(quote);

    expect(cache.getQuote()).toEqual(quote);
  });

  it('stores and retrieves an instrument', () => {
    const cache = new DataCache();
    cache.updateInstrument(instrument);

    expect(cache.getInstrument()).toEqual(instrument);
  });
});

// ---- Orchestrator -----------------------------------------------------

describe('Orchestrator', () => {
  let cache:  DataCache;
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    cache  = new DataCache();
    client = makeMockClient();
  });

  it('throws if start() is called without a strategy', async () => {
    const orch = new Orchestrator(cache, client);

    await expect(orch.start()).rejects.toThrow('Strategy not set');
  });

  it('seeds managed orders from REST on startup', async () => {
    const existing = [makeOrder({ clOrdID: 'tb_XBTUSD_000007' })];
    vi.mocked(client.getOrders).mockResolvedValueOnce(existing);

    const orch = new Orchestrator(cache, client);

    orch.setStrategy(new RangeStrategy(), makeConfig());
    await orch.start();
    await orch.stop();

    expect(client.getOrders).toHaveBeenCalledWith('XBTUSD');
  });

  it('continues the clOrdID sequence past the highest seeded order', async () => {
    cache.updateQuote(quote);
    cache.updateInstrument(instrument);

    // Seed REST with an existing managed order at sequence 41 — first new order
    // must therefore be 42, not 1 (would collide on a quick restart).
    vi.mocked(client.getOrders).mockResolvedValueOnce([
      makeOrder({ orderID: 'old-seed', clOrdID: 'tb_XBTUSD_000041', side: 'Buy', price: 500 }),
    ]);

    const orch = new Orchestrator(cache, client);

    orch.setStrategy(new RangeStrategy(), makeConfig());
    await orch.start();
    await orch.stop();

    const clOrdIDs = vi.mocked(client.createOrder).mock.calls.map((c) => c[1]);

    for (const id of clOrdIDs) {
      const seq = parseInt(id.replace('tb_XBTUSD_', ''), 10);
      expect(seq).toBeGreaterThan(41);
    }
  });

  it('creates orders on first tick when the cache has a quote', async () => {
    cache.updateQuote(quote);
    cache.updateInstrument(instrument);

    const orch = new Orchestrator(cache, client);

    orch.setStrategy(new RangeStrategy(), makeConfig());
    await orch.start();
    await orch.stop();

    // Range strategy produces one buy + one sell each tick
    expect(client.createOrder).toHaveBeenCalledTimes(2);
  });

  it('generates unique zero-padded clOrdIDs', async () => {
    cache.updateQuote(quote);
    cache.updateInstrument(instrument);

    const orch = new Orchestrator(cache, client);

    orch.setStrategy(new RangeStrategy(), makeConfig());
    await orch.start();
    await orch.stop();

    const clOrdIDs = vi.mocked(client.createOrder).mock.calls.map((c) => c[1]);

    expect(new Set(clOrdIDs).size).toBe(clOrdIDs.length);
    expect(clOrdIDs.every((id) => /^tb_XBTUSD_\d{6}$/.test(id))).toBe(true);
  });
});
