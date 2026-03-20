import { describe, it, expect } from 'vitest';
import { converge, filterActiveOrders } from '../src/converge';
import type { DesiredOrder, LiveOrder } from '../src/types';

const THRESHOLD = 0.25; // absolute USD

function makeLive(overrides: Partial<LiveOrder> = {}): LiveOrder {
  return {
    orderID:   'oid-1',
    clOrdID:   'tb_XBTUSD_000001',
    symbol:    'XBTUSD',
    side:      'Buy',
    ordType:   'Limit',
    ordStatus: 'New',
    price:     50000,
    leavesQty: 100,
    cumQty:    0,
    ...overrides,
  };
}

function makeDesired(overrides: Partial<DesiredOrder> = {}): DesiredOrder {
  return {
    side:     'Buy',
    ordType:  'Limit',
    orderQty: 100,
    price:    50000,
    ...overrides,
  };
}

// ── No-op: desired matches live exactly ──────────────────────────────────────

describe('converge — no-op', () => {
  it('returns empty ops when desired matches live exactly', () => {
    const desired = [makeDesired()];
    const live    = [makeLive()];
    const result  = converge(desired, live, THRESHOLD);

    expect(result.amends).toHaveLength(0);
    expect(result.creates).toHaveLength(0);
    expect(result.cancels).toHaveLength(0);
  });

  it('does not amend when price delta is within threshold', () => {
    const desired = [makeDesired({ price: 50000.1 })];
    const live    = [makeLive({   price: 50000 })];
    const result  = converge(desired, live, THRESHOLD);

    expect(result.amends).toHaveLength(0);
  });
});

// ── Amend ─────────────────────────────────────────────────────────────────────

describe('converge — amend', () => {
  it('amends when price delta exceeds threshold', () => {
    const desired = [makeDesired({ price: 50001 })];
    const live    = [makeLive({   price: 50000 })];
    const result  = converge(desired, live, THRESHOLD);

    expect(result.amends).toHaveLength(1);
    expect(result.amends[0]!.orderID).toBe('oid-1');
    expect(result.amends[0]!.price).toBe(50001);
    expect(result.creates).toHaveLength(0);
    expect(result.cancels).toHaveLength(0);
  });

  it('amends when desired quantity differs from live leavesQty', () => {
    const desired = [makeDesired({ orderQty: 200 })];
    const live    = [makeLive({   leavesQty: 100 })];
    const result  = converge(desired, live, THRESHOLD);

    expect(result.amends).toHaveLength(1);
    expect(result.amends[0]!.leavesQty).toBe(200);
    expect(result.amends[0]!.price).toBeUndefined();
  });

  it('sets leavesQty to desired orderQty regardless of partial fill', () => {
    const desired = [makeDesired({ orderQty: 100 })];
    const live    = [makeLive({   leavesQty: 70, cumQty: 30 })];
    const result  = converge(desired, live, THRESHOLD);

    expect(result.amends[0]!.leavesQty).toBe(100);
  });

  it('includes both price and leavesQty when both changed', () => {
    const desired = [makeDesired({ price: 50002, orderQty: 200 })];
    const live    = [makeLive({   price: 50000, leavesQty: 100 })];
    const result  = converge(desired, live, THRESHOLD);

    expect(result.amends[0]!.price).toBe(50002);
    expect(result.amends[0]!.leavesQty).toBe(200);
  });
});

// ── Create ────────────────────────────────────────────────────────────────────

describe('converge — create', () => {
  it('creates when desired has more orders than live', () => {
    const desired = [makeDesired(), makeDesired({ price: 49990 })];
    const live    = [makeLive()];
    const result  = converge(desired, live, THRESHOLD);

    expect(result.creates).toHaveLength(1);
    expect(result.creates[0]!.order.price).toBe(49990);
    expect(result.amends).toHaveLength(0);
    expect(result.cancels).toHaveLength(0);
  });

  it('creates all desired orders when live is empty', () => {
    const desired = [
      makeDesired({ price: 50000 }),
      makeDesired({ price: 49990, side: 'Sell' }),
    ];
    const result = converge(desired, [], THRESHOLD);

    expect(result.creates).toHaveLength(2);
    expect(result.amends).toHaveLength(0);
    expect(result.cancels).toHaveLength(0);
  });
});

// ── Cancel ────────────────────────────────────────────────────────────────────

describe('converge — cancel', () => {
  it('cancels when live has more orders than desired', () => {
    const desired: DesiredOrder[] = [];
    const live    = [makeLive({ orderID: 'oid-1' }), makeLive({ orderID: 'oid-2', price: 49990 })];
    const result  = converge(desired, live, THRESHOLD);

    expect(result.cancels).toHaveLength(2);
    expect(result.cancels.map((c) => c.orderID)).toEqual(expect.arrayContaining(['oid-1', 'oid-2']));
    expect(result.creates).toHaveLength(0);
    expect(result.amends).toHaveLength(0);
  });
});

// ── Sorting ───────────────────────────────────────────────────────────────────

describe('converge — positional matching', () => {
  it('matches bids closest-to-mid first (highest price first)', () => {
    const desired = [
      makeDesired({ price: 50000, orderQty: 100 }),
      makeDesired({ price: 49990, orderQty: 200 }),
    ];

    // Live orders provided in reverse price order; leavesQty matches only the correct pairing.
    // oid-near should pair with desired[0] (qty 100), oid-far with desired[1] (qty 200).
    const live = [
      makeLive({ orderID: 'oid-far',  price: 49990, leavesQty: 100 }),
      makeLive({ orderID: 'oid-near', price: 50000, leavesQty: 100 }),
    ];

    const result = converge(desired, live, THRESHOLD);

    // desired[0] (price 50000, qty 100) matches oid-near (price 50000, qty 100) → no amend
    // desired[1] (price 49990, qty 200) matches oid-far  (price 49990, qty 100) → amend qty
    const amendIds = result.amends.map((a) => a.orderID);

    expect(amendIds).not.toContain('oid-near'); // exact match — no amend
    expect(amendIds).toContain('oid-far');      // qty changed (100 → 200)
  });

  it('matches asks closest-to-mid first (lowest price first)', () => {
    const desired = [
      makeDesired({ side: 'Sell', price: 50010, orderQty: 100 }),
      makeDesired({ side: 'Sell', price: 50020, orderQty: 200 }),
    ];

    // oid-near should pair with desired[0] (qty 100), oid-far with desired[1] (qty 200).
    const live = [
      makeLive({ orderID: 'oid-far',  side: 'Sell', price: 50020, leavesQty: 100 }),
      makeLive({ orderID: 'oid-near', side: 'Sell', price: 50010, leavesQty: 100 }),
    ];

    const result = converge(desired, live, THRESHOLD);

    const amendIds = result.amends.map((a) => a.orderID);

    expect(amendIds).not.toContain('oid-near'); // exact match — no amend
    expect(amendIds).toContain('oid-far');      // qty changed (100 → 200)
  });
});

// ── filterActiveOrders ────────────────────────────────────────────────────────

describe('filterActiveOrders', () => {
  const orders: LiveOrder[] = [
    makeLive({ orderID: 'a', clOrdID: 'tb_XBTUSD_1', symbol: 'XBTUSD', ordStatus: 'New' }),
    makeLive({ orderID: 'b', clOrdID: 'tb_XBTUSD_2', symbol: 'XBTUSD', ordStatus: 'PartiallyFilled' }),
    makeLive({ orderID: 'c', clOrdID: 'tb_XBTUSD_3', symbol: 'XBTUSD', ordStatus: 'Filled' }),
    makeLive({ orderID: 'd', clOrdID: 'tb_XBTUSD_4', symbol: 'XBTUSD', ordStatus: 'Canceled' }),
    makeLive({ orderID: 'e', clOrdID: 'other_5',      symbol: 'XBTUSD', ordStatus: 'New' }),
    makeLive({ orderID: 'f', clOrdID: 'tb_ETHUSD_6', symbol: 'ETHUSD', ordStatus: 'New' }),
  ];

  it('includes only New and PartiallyFilled orders', () => {
    const result = filterActiveOrders(orders, 'XBTUSD');

    expect(result.map((o) => o.orderID)).toEqual(['a', 'b']);
  });

  it('excludes orders not owned by this executor (different prefix)', () => {
    const result = filterActiveOrders(orders, 'XBTUSD');

    expect(result.map((o) => o.orderID)).not.toContain('e');
  });

  it('excludes orders for a different symbol', () => {
    const result = filterActiveOrders(orders, 'XBTUSD');

    expect(result.map((o) => o.orderID)).not.toContain('f');
  });
});
