/**
 * Dispatch tests — table-keyed cache update routing.
 */

import { describe, it, expect } from 'vitest';
import { dispatch } from '../src/source/dispatch';
import { DataCache } from '../src/source/cache';

describe('dispatch — quote', () => {
  it('writes the most recent quote item to the cache', () => {
    const cache = new DataCache();

    dispatch('quote', [
      { symbol: 'XBTUSD', timestamp: 't1', bidPrice: 100, bidSize: 10, askPrice: 102, askSize: 10 },
      { symbol: 'XBTUSD', timestamp: 't2', bidPrice: 101, bidSize: 11, askPrice: 103, askSize: 12 },
    ], cache);

    const quote = cache.getQuote();

    expect(quote?.timestamp).toBe('t2');
    expect(quote?.bidPrice).toBe(101);
  });

  it('skips items with missing prices', () => {
    const cache = new DataCache();

    dispatch('quote', [{ symbol: 'XBTUSD', timestamp: 't1' }], cache);

    expect(cache.getQuote()).toBeNull();
  });
});

describe('dispatch — instrument', () => {
  it('seeds the instrument from a partial snapshot', () => {
    const cache = new DataCache();

    dispatch('instrument', [
      { symbol: 'XBTUSD', tickSize: 0.5, lotSize: 100, multiplier: 1, markPrice: 50000 },
    ], cache);

    const inst = cache.getInstrument();

    expect(inst?.tickSize).toBe(0.5);
    expect(inst?.lotSize).toBe(100);
    expect(inst?.markPrice).toBe(50000);
  });

  it('merges a sparse update onto the existing snapshot', () => {
    const cache = new DataCache();

    dispatch('instrument', [
      { symbol: 'XBTUSD', tickSize: 0.5, lotSize: 100, multiplier: 1, markPrice: 50000 },
    ], cache);

    dispatch('instrument', [{ symbol: 'XBTUSD', markPrice: 51000 }], cache);

    const inst = cache.getInstrument();

    expect(inst?.markPrice).toBe(51000);
    expect(inst?.tickSize).toBe(0.5);  // preserved
    expect(inst?.lotSize).toBe(100);   // preserved
  });

  it('drops the first message if it lacks tickSize/lotSize', () => {
    const cache = new DataCache();

    dispatch('instrument', [{ symbol: 'XBTUSD', markPrice: 50000 }], cache);

    expect(cache.getInstrument()).toBeNull();
  });
});

describe('dispatch — position', () => {
  it('seeds the position from the first message', () => {
    const cache = new DataCache();

    dispatch('position', [
      { symbol: 'XBTUSD', currentQty: 1000, markPrice: 50000, unrealisedPnl: 25 },
    ], cache);

    const pos = cache.getPosition();

    expect(pos?.currentQty).toBe(1000);
    expect(pos?.markPrice).toBe(50000);
    expect(pos?.unrealizedPnl).toBe(25);
  });

  it('merges sparse updates onto the existing position', () => {
    const cache = new DataCache();

    dispatch('position', [
      { symbol: 'XBTUSD', currentQty: 1000, markPrice: 50000 },
    ], cache);

    dispatch('position', [{ symbol: 'XBTUSD', currentQty: 1500 }], cache);

    const pos = cache.getPosition();

    expect(pos?.currentQty).toBe(1500);
    expect(pos?.markPrice).toBe(50000);
  });
});

describe('dispatch — unknown table', () => {
  it('is a no-op for tables with no handler', () => {
    const cache = new DataCache();

    dispatch('unknown', [{ anything: 'goes' }], cache);

    expect(cache.getQuote()).toBeNull();
    expect(cache.getInstrument()).toBeNull();
    expect(cache.getPosition()).toBeNull();
  });

  it('is a no-op for empty data arrays', () => {
    const cache = new DataCache();

    dispatch('quote', [], cache);

    expect(cache.getQuote()).toBeNull();
  });
});
