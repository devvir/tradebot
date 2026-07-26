/**
 * Managed-orders bookkeeping tests.
 */

import { describe, it, expect } from 'vitest';
import { applyToOrderList, buildClOrdID, seedSequence } from '../src/core/managed-orders';
import type { Order } from '../src/types';
import type { ApplyResult } from '../src/executor';

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    orderID:   'oid',
    clOrdID:   'tb_XBTUSD_000001',
    symbol:    'XBTUSD',
    side:      'Buy',
    price:     50000,
    orderQty:  100,
    leavesQty: 100,
    ordStatus: 'New',
    timestamp: '2026-04-29T00:00:00Z',
    ...overrides,
  };
}

function makeApply(overrides: Partial<ApplyResult> = {}): ApplyResult {
  return {
    created:      [],
    amended:      [],
    cancelledIds: [],
    summary:      { amends: 0, creates: 0, cancels: 0, staleFallback: 0 },
    ...overrides,
  };
}

describe('buildClOrdID', () => {
  it('zero-pads the sequence to 6 digits', () => {
    expect(buildClOrdID('XBTUSD', 0).id).toBe('tb_XBTUSD_000001');
    expect(buildClOrdID('XBTUSD', 41).id).toBe('tb_XBTUSD_000042');
  });

  it('returns the new sequence value for the caller to store', () => {
    expect(buildClOrdID('XBTUSD', 7).seq).toBe(8);
  });

  it('respects the symbol in the prefix', () => {
    expect(buildClOrdID('ETHUSD', 0).id).toBe('tb_ETHUSD_000001');
  });
});

describe('seedSequence', () => {
  it('returns 0 when there are no managed orders', () => {
    expect(seedSequence([], 'XBTUSD')).toBe(0);
  });

  it('returns the highest sequence number found across managed orders', () => {
    const orders = [
      makeOrder({ clOrdID: 'tb_XBTUSD_000001' }),
      makeOrder({ clOrdID: 'tb_XBTUSD_000042' }),
      makeOrder({ clOrdID: 'tb_XBTUSD_000017' }),
    ];

    expect(seedSequence(orders, 'XBTUSD')).toBe(42);
  });

  it('ignores orders with a different prefix', () => {
    const orders = [
      makeOrder({ clOrdID: 'tb_XBTUSD_000005' }),
      makeOrder({ clOrdID: 'tb_ETHUSD_999999' }),
      makeOrder({ clOrdID: 'someoneElses_42' }),
    ];

    expect(seedSequence(orders, 'XBTUSD')).toBe(5);
  });

  it('ignores orders with no clOrdID', () => {
    const orders = [
      makeOrder({ clOrdID: undefined }),
      makeOrder({ clOrdID: 'tb_XBTUSD_000003' }),
    ];

    expect(seedSequence(orders, 'XBTUSD')).toBe(3);
  });

  it('ignores entries whose tail is not numeric', () => {
    const orders = [
      makeOrder({ clOrdID: 'tb_XBTUSD_garbage' }),
      makeOrder({ clOrdID: 'tb_XBTUSD_000007' }),
    ];

    expect(seedSequence(orders, 'XBTUSD')).toBe(7);
  });
});

describe('applyToOrderList', () => {
  it('appends newly created orders', () => {
    const created = makeOrder({ orderID: 'new-1', clOrdID: 'tb_XBTUSD_000002' });
    const next    = applyToOrderList([], makeApply({ created: [created] }));

    expect(next).toHaveLength(1);
    expect(next[0]?.orderID).toBe('new-1');
  });

  it('replaces amended orders by orderID', () => {
    const before  = makeOrder({ orderID: 'oid-1', price: 50000 });
    const amended = makeOrder({ orderID: 'oid-1', price: 50100 });
    const next    = applyToOrderList([before], makeApply({ amended: [amended] }));

    expect(next).toHaveLength(1);
    expect(next[0]?.price).toBe(50100);
  });

  it('drops cancelled orders by ID', () => {
    const a    = makeOrder({ orderID: 'oid-a' });
    const b    = makeOrder({ orderID: 'oid-b' });
    const next = applyToOrderList([a, b], makeApply({ cancelledIds: ['oid-a'] }));

    expect(next).toHaveLength(1);
    expect(next[0]?.orderID).toBe('oid-b');
  });

  it('does not mutate the input array', () => {
    const before = [makeOrder({ orderID: 'oid-1' })];
    const before_copy = [...before];

    applyToOrderList(before, makeApply({ created: [makeOrder({ orderID: 'new' })] }));

    expect(before).toEqual(before_copy);
  });

  it('handles a mixed result with creates, amends, and cancels', () => {
    const keep    = makeOrder({ orderID: 'keep' });
    const updateA = makeOrder({ orderID: 'amend', price: 50000 });
    const cancel  = makeOrder({ orderID: 'cancel' });

    const amended = makeOrder({ orderID: 'amend',   price: 50500 });
    const created = makeOrder({ orderID: 'create',  clOrdID: 'tb_XBTUSD_000003' });

    const next = applyToOrderList(
      [keep, updateA, cancel],
      makeApply({ amended: [amended], created: [created], cancelledIds: ['cancel'] }),
    );

    const ids = next.map((o) => o.orderID).sort();

    expect(ids).toEqual(['amend', 'create', 'keep']);
    expect(next.find((o) => o.orderID === 'amend')?.price).toBe(50500);
  });
});
