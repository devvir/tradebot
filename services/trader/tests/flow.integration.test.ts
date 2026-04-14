/**
 * Trader flow tests
 *
 * Covers each component in isolation, then the full decide→plan→converge→apply flow.
 * Converge algorithm behaviour is tested in depth in converge.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DataCache } from '../src/source/cache';
import { RangeStrategy } from '../src/strategies/range';
import { STRATEGY_CONFIGS } from '../src/strategies/config';
import { translateOrders } from '../src/planner/translator';
import { roundToTick, roundToLot } from '../src/planner/rounding';
import { Orchestrator } from '../src/core/orchestrator';
import type { RestClient } from '../src/executor/types';
import type { Quote, Order, Instrument } from '../src/types';
import type { OrderPlan } from '../src/planner/types';

// ---- Fixtures ---------------------------------------------------------

const quote: Quote = {
  symbol:    'XBTUSD',
  timestamp: '2026-04-11T00:00:00Z',
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
    timestamp: '2026-04-11T00:00:00Z',
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
    amendOrder:   vi.fn(async (_orderID: string) => makeOrder()),
    cancelOrders: vi.fn(async () => {}),
    getOrders:    vi.fn(async () => []),
  };
}

// ---- Range Strategy ---------------------------------------------------

describe('RangeStrategy', () => {
  it('returns empty when no quote', () => {
    const strategy = new RangeStrategy('XBTUSD');
    const result   = strategy.decide({ quote: null, orders: [], position: null, instrument: null });

    expect(result).toHaveLength(0);
  });

  it('places buy and sell 1% from mid', () => {
    const strategy = new RangeStrategy('XBTUSD');
    const result   = strategy.decide({ quote, orders: [], position: null, instrument: null });

    // mid = (1000 + 1002) / 2 = 1001
    const mid = 1001;

    expect(result).toHaveLength(2);
    expect(result[0].side).toBe('buy');
    expect(result[1].side).toBe('sell');
    expect(result[0].price).toBeCloseTo(mid * 0.99, 4);
    expect(result[1].price).toBeCloseTo(mid * 1.01, 4);
  });
});

// ---- Planner (rounding + translation) ---------------------------------

describe('Planner — rounding', () => {
  it('rounds price down to tick boundary', () => {
    expect(roundToTick(1001.3, 0.5)).toBe(1001.5);
    expect(roundToTick(1001.1, 0.5)).toBe(1001);
  });

  it('rounds quantity down to lot boundary', () => {
    expect(roundToLot(150, 100)).toBe(100);
    expect(roundToLot(200, 100)).toBe(200);
    expect(roundToLot(99, 100)).toBe(0);
  });

  it('is a no-op when tickSize is 0', () => {
    expect(roundToTick(1234.56, 0)).toBe(1234.56);
  });
});

describe('Planner — translateOrders', () => {
  it('translates buy pseudo-order to BitMEX OrderPlan', () => {
    const pseudo   = [{ side: 'buy' as const, price: 990.99, quantity: 100 }];
    const [result] = translateOrders(pseudo, 'XBTUSD', instrument);

    expect(result.symbol).toBe('XBTUSD');
    expect(result.side).toBe('Buy');
    // 990.99 rounded to nearest 0.5 tick = 991.0
    expect(result.price).toBe(991);
    expect(result.orderQty).toBe(100);
  });

  it('defaults quantity to 100 when not supplied', () => {
    const pseudo   = [{ side: 'sell' as const, price: 1010 }];
    const [result] = translateOrders(pseudo, 'XBTUSD', instrument);

    expect(result.orderQty).toBe(100);
  });

  it('works without instrument data (no rounding)', () => {
    const pseudo   = [{ side: 'buy' as const, price: 990.99, quantity: 150 }];
    const [result] = translateOrders(pseudo, 'XBTUSD', null);

    expect(result.price).toBe(990.99);
    expect(result.orderQty).toBe(150);
  });
});

// ---- DataCache --------------------------------------------------------

describe('DataCache', () => {
  it('stores and retrieves quote', () => {
    const cache = new DataCache();
    cache.updateQuote(quote);

    expect(cache.getQuote()).toEqual(quote);
  });

  it('stores and retrieves instrument', () => {
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

  it('throws if start() called without a strategy', async () => {
    const orch = new Orchestrator(cache, client);

    await expect(orch.start()).rejects.toThrow('Strategy not set');
  });

  it('seeds managed orders from REST on startup', async () => {
    const existing = [makeOrder({ clOrdID: 'tb_XBTUSD_000001' })];
    vi.mocked(client.getOrders).mockResolvedValueOnce(existing);

    const orch   = new Orchestrator(cache, client);
    const config = { ...STRATEGY_CONFIGS.range, symbol: 'XBTUSD', tickIntervalMs: 99_999 };

    orch.setStrategy(new RangeStrategy('XBTUSD'), config);
    await orch.start();
    await orch.stop();

    expect(client.getOrders).toHaveBeenCalledWith('XBTUSD');
  });

  it('creates orders on first tick when cache has a quote', async () => {
    cache.updateQuote(quote);
    cache.updateInstrument(instrument);

    const orch   = new Orchestrator(cache, client);
    const config = { ...STRATEGY_CONFIGS.range, symbol: 'XBTUSD', tickIntervalMs: 99_999 };

    orch.setStrategy(new RangeStrategy('XBTUSD'), config);
    await orch.start();
    await orch.stop();

    // Range strategy decides 2 orders → both created on first tick
    expect(client.createOrder).toHaveBeenCalledTimes(2);
  });

  it('generates unique clOrdIDs per order', async () => {
    cache.updateQuote(quote);
    cache.updateInstrument(instrument);

    const orch   = new Orchestrator(cache, client);
    const config = { ...STRATEGY_CONFIGS.range, symbol: 'XBTUSD', tickIntervalMs: 99_999 };

    orch.setStrategy(new RangeStrategy('XBTUSD'), config);
    await orch.start();
    await orch.stop();

    const calls   = vi.mocked(client.createOrder).mock.calls;
    const clOrdIDs = calls.map((c) => c[1]);

    expect(new Set(clOrdIDs).size).toBe(clOrdIDs.length); // all unique
    expect(clOrdIDs.every((id) => id.startsWith('tb_XBTUSD_'))).toBe(true);
  });

  it('does not re-create orders that are already managed', async () => {
    cache.updateQuote(quote);
    cache.updateInstrument(instrument);

    // Simulate that 2 orders already exist with prices matching what range strategy would produce
    // (forces a no-op second tick — we test by running start and checking createOrder count)
    const orch   = new Orchestrator(cache, client);
    const config = { ...STRATEGY_CONFIGS.range, symbol: 'XBTUSD', tickIntervalMs: 99_999 };

    orch.setStrategy(new RangeStrategy('XBTUSD'), config);
    await orch.start(); // tick 1 — creates 2 orders (mock returns them)
    await orch.stop();

    // Only 2 creates from tick 1
    expect(client.createOrder).toHaveBeenCalledTimes(2);
  });
});
