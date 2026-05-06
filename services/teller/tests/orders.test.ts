import { describe, it, expect } from 'vitest';
import { createOrder, amendOrder, cancelOrder, cancelAllOrders } from '../src/orders/index';
import { initAccount } from '../src/accounts/index';
import type { AccountState } from '../src/types';
import { TellerError } from '../src/types';

const TS = '2024-01-01T00:00:00.000Z';

function freshState(): AccountState {
  return initAccount('acc1', 10_000_000, TS);
}

const LIMIT_REQ = {
  symbol:    'XBTUSD',
  side:      'Buy' as const,
  ordType:   'Limit' as const,
  orderQty:  100,
  price:     50_000,
  timestamp: TS,
};

const MARKET_REQ = {
  symbol:    'XBTUSD',
  side:      'Sell' as const,
  ordType:   'Market' as const,
  orderQty:  100,
  timestamp: TS,
};

// ── createOrder ───────────────────────────────────────────────────────────────

describe('createOrder', () => {
  it('creates a limit order with correct fields', () => {
    const { order } = createOrder(freshState(), LIMIT_REQ);

    expect(order.symbol).toBe('XBTUSD');
    expect(order.side).toBe('Buy');
    expect(order.ordType).toBe('Limit');
    expect(order.price).toBe(50_000);
    expect(order.orderQty).toBe(100);
    expect(order.leavesQty).toBe(100);
    expect(order.cumQty).toBe(0);
    expect(order.ordStatus).toBe('New');
    expect(order.avgPx).toBeNull();
    expect(order.text).toBe('Submitted');
  });

  it('creates a market order with null price', () => {
    const { order } = createOrder(freshState(), MARKET_REQ);

    expect(order.ordType).toBe('Market');
    expect(order.price).toBeNull();
  });

  it('assigns a unique orderID to each order', () => {
    const state = freshState();
    const { order: o1 } = createOrder(state, LIMIT_REQ);
    const { order: o2 } = createOrder(state, { ...LIMIT_REQ, clOrdID: 'cl-2' });

    expect(o1.orderID).not.toBe(o2.orderID);
  });

  it('uses provided clOrdID', () => {
    const { order } = createOrder(freshState(), { ...LIMIT_REQ, clOrdID: 'my-cl-id' });

    expect(order.clOrdID).toBe('my-cl-id');
  });

  it('generates clOrdID when not provided', () => {
    const { order } = createOrder(freshState(), LIMIT_REQ);

    expect(typeof order.clOrdID).toBe('string');
    expect(order.clOrdID.length).toBeGreaterThan(0);
  });

  it('adds order to state map', () => {
    const { state, order } = createOrder(freshState(), LIMIT_REQ);

    expect(state.orders.has(order.orderID)).toBe(true);
  });

  it('does not mutate the input state', () => {
    const before = freshState();
    createOrder(before, LIMIT_REQ);

    expect(before.orders.size).toBe(0);
  });

  it('throws on duplicate clOrdID', () => {
    const { state } = createOrder(freshState(), { ...LIMIT_REQ, clOrdID: 'dup' });

    expect(() => createOrder(state, { ...LIMIT_REQ, clOrdID: 'dup' })).toThrow(TellerError);
  });

  it('throws for limit order without price', () => {
    expect(() => createOrder(freshState(), { ...LIMIT_REQ, price: undefined })).toThrow(TellerError);
  });

  it('throws for limit order with price <= 0', () => {
    expect(() => createOrder(freshState(), { ...LIMIT_REQ, price: 0 })).toThrow(TellerError);
  });

  it('throws for orderQty <= 0', () => {
    expect(() => createOrder(freshState(), { ...LIMIT_REQ, orderQty: 0 })).toThrow(TellerError);
  });

  it('throws for unsupported ordType', () => {
    expect(() => createOrder(freshState(), { ...LIMIT_REQ, ordType: 'Stop' as never })).toThrow(TellerError);
  });
});

// ── amendOrder ────────────────────────────────────────────────────────────────

describe('amendOrder', () => {
  it('amends the price of an open limit order', () => {
    const { state: s1, order } = createOrder(freshState(), LIMIT_REQ);
    const { order: amended } = amendOrder(s1, order.orderID, { price: 48_000 });

    expect(amended.price).toBe(48_000);
    expect(amended.ordStatus).toBe('New');
  });

  it('amends orderQty and recomputes leavesQty', () => {
    const { state: s1, order } = createOrder(freshState(), LIMIT_REQ);
    const { order: amended } = amendOrder(s1, order.orderID, { orderQty: 200 });

    expect(amended.orderQty).toBe(200);
    expect(amended.leavesQty).toBe(200);
  });

  it('cancels the order when new orderQty <= cumQty', () => {
    const { state: s1, order } = createOrder(freshState(), LIMIT_REQ);

    // Simulate partial fill by directly patching a copy
    const partialFilled = { ...order, cumQty: 50, leavesQty: 50 };
    const s2: AccountState = { ...s1, orders: new Map([[order.orderID, partialFilled]]) };

    const { order: amended } = amendOrder(s2, order.orderID, { orderQty: 50 });

    expect(amended.ordStatus).toBe('Canceled');
    expect(amended.leavesQty).toBe(0);
    expect(amended.text).toBe('Canceled by amend');
  });

  it('removes canceled-by-amend order from state', () => {
    const { state: s1, order } = createOrder(freshState(), LIMIT_REQ);

    // cumQty = 0, orderQty = 0 → effectively cancels
    const { state: s2 } = amendOrder(s1, order.orderID, { orderQty: 0 });

    expect(s2.orders.has(order.orderID)).toBe(false);
  });

  it('keeps amended order in state when not canceled', () => {
    const { state: s1, order } = createOrder(freshState(), LIMIT_REQ);
    const { state: s2 } = amendOrder(s1, order.orderID, { price: 49_000 });

    expect(s2.orders.has(order.orderID)).toBe(true);
  });

  it('does not mutate the input state', () => {
    const { state: s1, order } = createOrder(freshState(), LIMIT_REQ);
    amendOrder(s1, order.orderID, { price: 49_000 });

    expect(s1.orders.get(order.orderID)!.price).toBe(50_000);
  });

  it('throws 404 when order not found', () => {
    expect(() => amendOrder(freshState(), 'nonexistent', { price: 49_000 }))
      .toThrow(expect.objectContaining({ statusCode: 404 }));
  });

  it('throws when amending a Filled order', () => {
    const { state: s1, order } = createOrder(freshState(), LIMIT_REQ);
    const filled = { ...order, ordStatus: 'Filled' as const };
    const s2: AccountState = { ...s1, orders: new Map([[order.orderID, filled]]) };

    expect(() => amendOrder(s2, order.orderID, { price: 49_000 })).toThrow(TellerError);
  });

  it('throws when amending a Canceled order', () => {
    const { state: s1, order } = createOrder(freshState(), LIMIT_REQ);
    const canceled = { ...order, ordStatus: 'Canceled' as const };
    const s2: AccountState = { ...s1, orders: new Map([[order.orderID, canceled]]) };

    expect(() => amendOrder(s2, order.orderID, { price: 49_000 })).toThrow(TellerError);
  });
});

// ── cancelOrder ───────────────────────────────────────────────────────────────

describe('cancelOrder', () => {
  it('cancels an open order', () => {
    const { state: s1, order } = createOrder(freshState(), LIMIT_REQ);
    const { order: canceled } = cancelOrder(s1, order.orderID);

    expect(canceled.ordStatus).toBe('Canceled');
    expect(canceled.leavesQty).toBe(0);
  });

  it('uses default cancel text', () => {
    const { state: s1, order } = createOrder(freshState(), LIMIT_REQ);
    const { order: canceled } = cancelOrder(s1, order.orderID);

    expect(canceled.text).toBe('Canceled');
  });

  it('accepts a custom cancel text', () => {
    const { state: s1, order } = createOrder(freshState(), LIMIT_REQ);
    const { order: canceled } = cancelOrder(s1, order.orderID, 'Killed by admin');

    expect(canceled.text).toBe('Killed by admin');
  });

  it('removes the order from state', () => {
    const { state: s1, order } = createOrder(freshState(), LIMIT_REQ);
    const { state: s2 } = cancelOrder(s1, order.orderID);

    expect(s2.orders.has(order.orderID)).toBe(false);
  });

  it('does not mutate the input state', () => {
    const { state: s1, order } = createOrder(freshState(), LIMIT_REQ);
    cancelOrder(s1, order.orderID);

    expect(s1.orders.has(order.orderID)).toBe(true);
  });

  it('throws 404 when order not found', () => {
    expect(() => cancelOrder(freshState(), 'nonexistent'))
      .toThrow(expect.objectContaining({ statusCode: 404 }));
  });

  it('throws when order is already Filled', () => {
    const { state: s1, order } = createOrder(freshState(), LIMIT_REQ);
    const filled = { ...order, ordStatus: 'Filled' as const };
    const s2: AccountState = { ...s1, orders: new Map([[order.orderID, filled]]) };

    expect(() => cancelOrder(s2, order.orderID)).toThrow(TellerError);
  });
});

// ── cancelAllOrders ───────────────────────────────────────────────────────────

describe('cancelAllOrders', () => {
  it('cancels all orders when no symbol filter', () => {
    const { state: s1, order: o1 } = createOrder(freshState(), LIMIT_REQ);
    const { state: s2, order: o2 } = createOrder(s1, { ...LIMIT_REQ, clOrdID: 'cl-2', symbol: 'ETHUSD' });

    const { state: s3, orders } = cancelAllOrders(s2);

    expect(orders).toHaveLength(2);
    expect(s3.orders.size).toBe(0);
    expect(orders.find(o => o.orderID === o1.orderID)!.ordStatus).toBe('Canceled');
    expect(orders.find(o => o.orderID === o2.orderID)!.ordStatus).toBe('Canceled');
  });

  it('cancels only matching symbol when filter provided', () => {
    const { state: s1 } = createOrder(freshState(), LIMIT_REQ);
    const { state: s2, order: eth } = createOrder(s1, { ...LIMIT_REQ, clOrdID: 'cl-2', symbol: 'ETHUSD' });

    const { state: s3, orders } = cancelAllOrders(s2, 'XBTUSD');

    expect(orders).toHaveLength(1);
    expect(orders[0]!.symbol).toBe('XBTUSD');
    expect(s3.orders.has(eth.orderID)).toBe(true);
  });

  it('returns empty array and unchanged state when no orders match', () => {
    const { state: s1 } = createOrder(freshState(), LIMIT_REQ);
    const { state: s2, orders } = cancelAllOrders(s1, 'ETHUSD');

    expect(orders).toHaveLength(0);
    expect(s2.orders.size).toBe(1);
  });

  it('does not mutate the input state', () => {
    const { state: s1, order } = createOrder(freshState(), LIMIT_REQ);
    cancelAllOrders(s1);

    expect(s1.orders.has(order.orderID)).toBe(true);
  });
});
