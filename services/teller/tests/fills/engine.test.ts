import { describe, it, expect } from 'vitest';
import { computeGuard, guardAllows, findCrossings } from '../../src/fills/engine';
import type { OrderDoc } from '../../src/types';

const TS = '2024-01-01T00:00:00.000Z';

function limitOrder(overrides: Partial<OrderDoc> = {}): OrderDoc {
  return {
    orderID:   'oid-1',
    clOrdID:   'cl-1',
    accountId: 'acc1',
    symbol:    'XBTUSD',
    side:      'Buy',
    ordType:   'Limit',
    price:     50_000,
    orderQty:  100,
    leavesQty: 100,
    cumQty:    0,
    avgPx:     null,
    ordStatus: 'New',
    timestamp: TS,
    text:      'Submitted',
    ...overrides,
  };
}

// ── computeGuard ──────────────────────────────────────────────────────────────

describe('computeGuard', () => {
  it('returns null/null for an empty order list', () => {
    const guard = computeGuard([]);

    expect(guard.highestBid).toBeNull();
    expect(guard.lowestAsk).toBeNull();
  });

  it('picks highestBid from buy limits', () => {
    const orders = [
      limitOrder({ orderID: 'b1', side: 'Buy', price: 50_000 }),
      limitOrder({ orderID: 'b2', side: 'Buy', price: 51_000 }),
    ];

    expect(computeGuard(orders).highestBid).toBe(51_000);
  });

  it('picks lowestAsk from sell limits', () => {
    const orders = [
      limitOrder({ orderID: 's1', side: 'Sell', price: 52_000 }),
      limitOrder({ orderID: 's2', side: 'Sell', price: 53_000 }),
    ];

    expect(computeGuard(orders).lowestAsk).toBe(52_000);
  });

  it('ignores market orders', () => {
    const orders = [limitOrder({ ordType: 'Market', price: null })];

    expect(computeGuard(orders).highestBid).toBeNull();
  });

  it('ignores orders with leavesQty = 0', () => {
    const orders = [limitOrder({ leavesQty: 0, price: 50_000 })];

    expect(computeGuard(orders).highestBid).toBeNull();
  });

  it('ignores orders with null price', () => {
    const orders = [limitOrder({ price: null })];

    expect(computeGuard(orders).highestBid).toBeNull();
  });

  it('computes both sides simultaneously', () => {
    const orders = [
      limitOrder({ orderID: 'b1', side: 'Buy',  price: 50_000 }),
      limitOrder({ orderID: 's1', side: 'Sell', price: 52_000 }),
    ];
    const guard = computeGuard(orders);

    expect(guard.highestBid).toBe(50_000);
    expect(guard.lowestAsk).toBe(52_000);
  });
});

// ── guardAllows ───────────────────────────────────────────────────────────────

describe('guardAllows', () => {
  it('returns false when both sides are null (no orders)', () => {
    expect(guardAllows({ highestBid: null, lowestAsk: null }, 50_000)).toBe(false);
  });

  it('returns true when trade price <= highestBid (buy limit crossed)', () => {
    expect(guardAllows({ highestBid: 50_000, lowestAsk: null }, 50_000)).toBe(true);
    expect(guardAllows({ highestBid: 50_000, lowestAsk: null }, 49_999)).toBe(true);
  });

  it('returns false when trade price > highestBid (no buy limit crossed)', () => {
    expect(guardAllows({ highestBid: 50_000, lowestAsk: null }, 50_001)).toBe(false);
  });

  it('returns true when trade price >= lowestAsk (sell limit crossed)', () => {
    expect(guardAllows({ highestBid: null, lowestAsk: 52_000 }, 52_000)).toBe(true);
    expect(guardAllows({ highestBid: null, lowestAsk: 52_000 }, 52_001)).toBe(true);
  });

  it('returns false when trade price < lowestAsk (no sell limit crossed)', () => {
    expect(guardAllows({ highestBid: null, lowestAsk: 52_000 }, 51_999)).toBe(false);
  });

  it('returns true if either side allows crossing', () => {
    // trade at 51_000: below highestBid (no) but above lowestAsk (yes)
    expect(guardAllows({ highestBid: 50_000, lowestAsk: 51_000 }, 51_000)).toBe(true);
  });
});

// ── findCrossings ─────────────────────────────────────────────────────────────

describe('findCrossings', () => {
  it('returns empty array when no orders exist', () => {
    expect(findCrossings([], 50_000)).toHaveLength(0);
  });

  it('crosses a buy limit when trade price drops to the limit price', () => {
    const orders = [limitOrder({ side: 'Buy', price: 50_000 })];
    const crossed = findCrossings(orders, 50_000);

    expect(crossed).toHaveLength(1);
    expect(crossed[0]!.orderID).toBe('oid-1');
  });

  it('crosses a buy limit when trade price falls below the limit price', () => {
    const orders = [limitOrder({ side: 'Buy', price: 50_000 })];

    expect(findCrossings(orders, 49_000)).toHaveLength(1);
  });

  it('does not cross a buy limit when trade price is above the limit price', () => {
    const orders = [limitOrder({ side: 'Buy', price: 50_000 })];

    expect(findCrossings(orders, 51_000)).toHaveLength(0);
  });

  it('crosses a sell limit when trade price rises to the limit price', () => {
    const orders = [limitOrder({ side: 'Sell', price: 52_000 })];
    const crossed = findCrossings(orders, 52_000);

    expect(crossed).toHaveLength(1);
  });

  it('crosses a sell limit when trade price exceeds the limit price', () => {
    const orders = [limitOrder({ side: 'Sell', price: 52_000 })];

    expect(findCrossings(orders, 53_000)).toHaveLength(1);
  });

  it('does not cross a sell limit when trade price is below the limit price', () => {
    const orders = [limitOrder({ side: 'Sell', price: 52_000 })];

    expect(findCrossings(orders, 51_000)).toHaveLength(0);
  });

  it('crosses multiple buy limits at the same level', () => {
    const orders = [
      limitOrder({ orderID: 'b1', side: 'Buy', price: 50_000 }),
      limitOrder({ orderID: 'b2', side: 'Buy', price: 50_000 }),
    ];

    expect(findCrossings(orders, 50_000)).toHaveLength(2);
  });

  it('crosses only buy limits at or above trade price (early exit)', () => {
    const orders = [
      limitOrder({ orderID: 'b1', side: 'Buy', price: 52_000 }),
      limitOrder({ orderID: 'b2', side: 'Buy', price: 50_000 }),
      limitOrder({ orderID: 'b3', side: 'Buy', price: 48_000 }),
    ];
    // trade @ 50_000: crosses 52_000 and 50_000, not 48_000
    const crossed = findCrossings(orders, 50_000);

    expect(crossed).toHaveLength(2);
    expect(crossed.map(o => o.orderID)).toContain('b1');
    expect(crossed.map(o => o.orderID)).toContain('b2');
  });

  it('crosses buy and sell limits simultaneously when trade hits both', () => {
    // trade @ 51_000: crosses bid @ 51_000 and ask @ 51_000
    const orders = [
      limitOrder({ orderID: 'b1', side: 'Buy',  price: 51_000 }),
      limitOrder({ orderID: 's1', side: 'Sell', price: 51_000 }),
    ];

    expect(findCrossings(orders, 51_000)).toHaveLength(2);
  });

  it('ignores market orders', () => {
    const orders = [limitOrder({ ordType: 'Market', price: null })];

    expect(findCrossings(orders, 50_000)).toHaveLength(0);
  });

  it('ignores orders with leavesQty = 0', () => {
    const orders = [limitOrder({ leavesQty: 0, price: 50_000 })];

    expect(findCrossings(orders, 50_000)).toHaveLength(0);
  });

  it('returns buy crossings sorted most aggressive first', () => {
    const orders = [
      limitOrder({ orderID: 'b-low',  side: 'Buy', price: 50_000 }),
      limitOrder({ orderID: 'b-high', side: 'Buy', price: 52_000 }),
    ];
    const crossed = findCrossings(orders, 49_000);

    expect(crossed[0]!.orderID).toBe('b-high');
  });
});
