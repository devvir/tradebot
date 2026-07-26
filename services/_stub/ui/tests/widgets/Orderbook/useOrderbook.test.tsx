import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOrderbook } from '../../../src/widgets/Orderbook/useOrderbook';
import { makeFakeBitmex, makeBitmexWrapper, type FakeBitmex } from '../../helpers/fakeBitmex';
import type { OrderBookLevel } from '../../../src/types';

let fake: FakeBitmex;

beforeEach(() => {
  fake = makeFakeBitmex();
});

const lvl = (over: Partial<OrderBookLevel>): OrderBookLevel => ({
  symbol: 'XBTUSD',
  id:     0,
  side:   'Sell',
  size:   1,
  price:  100,
  ...over,
});

// ── partial / snapshot ────────────────────────────────────────────────────────

describe('useOrderbook — partial snapshot', () => {
  it('builds asks (worst-first on top, best at the bottom) with cumulative totals', () => {
    const { result } = renderHook(() => useOrderbook(), { wrapper: makeBitmexWrapper(fake) });

    act(() => {
      fake.emit<OrderBookLevel>('orderBookL2_25:XBTUSD', 'partial', [
        lvl({ id: 1, side: 'Sell', price: 100, size: 1 }),
        lvl({ id: 2, side: 'Sell', price: 101, size: 2 }),
        lvl({ id: 3, side: 'Sell', price: 102, size: 4 }),
      ]);
    });

    /** Worst (highest price) at index 0, best at the end; totals accumulate downward from worst. */
    expect(result.current.asks.map(r => r.price)).toEqual([102, 101, 100]);
    expect(result.current.asks.map(r => r.total)).toEqual([4, 6, 7]);
    expect(result.current.bestAsk).toBe(100);
  });

  it('builds bids (worst-first on top, best at bottom) with cumulative totals', () => {
    const { result } = renderHook(() => useOrderbook(), { wrapper: makeBitmexWrapper(fake) });

    act(() => {
      fake.emit<OrderBookLevel>('orderBookL2_25:XBTUSD', 'partial', [
        lvl({ id: 10, side: 'Buy', price: 99,  size: 3 }),
        lvl({ id: 11, side: 'Buy', price: 98,  size: 5 }),
        lvl({ id: 12, side: 'Buy', price: 97,  size: 7 }),
      ]);
    });

    expect(result.current.bids.map(r => r.price)).toEqual([97, 98, 99]);
    expect(result.current.bids.map(r => r.total)).toEqual([7, 12, 15]);
    expect(result.current.bestBid).toBe(99);
  });

  it('computes spread from best ask and best bid', () => {
    const { result } = renderHook(() => useOrderbook(), { wrapper: makeBitmexWrapper(fake) });

    act(() => {
      fake.emit<OrderBookLevel>('orderBookL2_25:XBTUSD', 'partial', [
        lvl({ id: 1, side: 'Sell', price: 100, size: 1 }),
        lvl({ id: 2, side: 'Buy',  price: 99,  size: 1 }),
      ]);
    });

    expect(result.current.spread).toBe(1);
  });
});

// ── incremental updates ───────────────────────────────────────────────────────

describe('useOrderbook — incremental updates', () => {
  it('insert adds a new level', () => {
    const { result } = renderHook(() => useOrderbook(), { wrapper: makeBitmexWrapper(fake) });

    act(() => {
      fake.emit<OrderBookLevel>('orderBookL2_25:XBTUSD', 'partial', [
        lvl({ id: 1, side: 'Sell', price: 100, size: 1 }),
      ]);
    });

    act(() => {
      fake.emit<OrderBookLevel>('orderBookL2_25:XBTUSD', 'insert', [
        lvl({ id: 2, side: 'Sell', price: 101, size: 2 }),
      ]);
    });

    expect(result.current.asks.map(r => r.price)).toEqual([101, 100]);
  });

  it('update modifies size of an existing level (keyed by symbol:id:side)', () => {
    const { result } = renderHook(() => useOrderbook(), { wrapper: makeBitmexWrapper(fake) });

    act(() => {
      fake.emit<OrderBookLevel>('orderBookL2_25:XBTUSD', 'partial', [
        lvl({ id: 1, side: 'Sell', price: 100, size: 1 }),
      ]);
    });

    act(() => {
      fake.emit<OrderBookLevel>('orderBookL2_25:XBTUSD', 'update', [
        lvl({ id: 1, side: 'Sell', size: 42 }),
      ]);
    });

    expect(result.current.asks[0].size).toBe(42);
  });

  it('delete removes a level', () => {
    const { result } = renderHook(() => useOrderbook(), { wrapper: makeBitmexWrapper(fake) });

    act(() => {
      fake.emit<OrderBookLevel>('orderBookL2_25:XBTUSD', 'partial', [
        lvl({ id: 1, side: 'Sell', price: 100, size: 1 }),
        lvl({ id: 2, side: 'Sell', price: 101, size: 2 }),
      ]);
    });

    act(() => {
      fake.emit<OrderBookLevel>('orderBookL2_25:XBTUSD', 'delete', [
        lvl({ id: 1, side: 'Sell' }),
      ]);
    });

    expect(result.current.asks.map(r => r.price)).toEqual([101]);
  });
});

// ── subscription lifecycle ────────────────────────────────────────────────────

describe('useOrderbook — subscription lifecycle', () => {
  it('subscribes on mount and unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useOrderbook(), { wrapper: makeBitmexWrapper(fake) });

    expect(fake.subscriberCount('orderBookL2_25:XBTUSD')).toBeGreaterThan(0);

    unmount();

    expect(fake.subscriberCount('orderBookL2_25:XBTUSD')).toBe(0);
  });

  it('caps display at 25 levels per side', () => {
    const many = Array.from({ length: 60 }, (_, i) => lvl({ id: i, side: 'Sell', price: 100 + i, size: 1 }));

    const { result } = renderHook(() => useOrderbook(), { wrapper: makeBitmexWrapper(fake) });

    act(() => { fake.emit<OrderBookLevel>('orderBookL2_25:XBTUSD', 'partial', many); });

    expect(result.current.asks).toHaveLength(25);
  });
});
