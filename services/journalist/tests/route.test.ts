import { describe, it, expect } from 'vitest';
import { routeMessage, bucketDay, vaultTable, isPooledFanout } from '../src/route';
import type { BitmexDataItem } from '../src/types';

const items = (...d: Record<string, unknown>[]): BitmexDataItem[] => d as BitmexDataItem[];

describe('routeMessage', () => {
  it('passes a non-trade table through as a single group', () => {
    const data = items({ symbol: 'XBTUSD', bidPrice: 1 }, { symbol: 'ETHUSD', bidPrice: 2 });

    expect(routeMessage('quote', data)).toEqual([{ table: 'quote', data }]);
  });

  it('splits trade into real prints (trade) and referential ticks (tick) by size', () => {
    const real = { symbol: 'XBTUSD', size: 100, price: 50000 };
    const tick = { symbol: '.BXBT', size: 0, price: 50001 };

    expect(routeMessage('trade', items(real, tick))).toEqual([
      { table: 'trade', data: [real] },
      { table: 'tick',  data: [tick] },
    ]);
  });

  it('emits only the trade group when there are no ticks', () => {
    const real = { symbol: 'XBTUSD', size: 3, price: 50000 };

    expect(routeMessage('trade', items(real))).toEqual([{ table: 'trade', data: [real] }]);
  });

  it('emits only the tick group when every print is referential', () => {
    const tick = { symbol: '.BXBT', size: 0, price: 50001 };

    expect(routeMessage('trade', items(tick))).toEqual([{ table: 'tick', data: [tick] }]);
  });

  it('passes an empty trade message through as a single group (never lost)', () => {
    expect(routeMessage('trade', [])).toEqual([{ table: 'trade', data: [] }]);
  });
});

describe('vaultTable', () => {
  it('keeps the base name for non-pooled-fanout tables regardless of pool', () => {
    expect(vaultTable('quote', items({ symbol: 'XBTUSD', pool: 'Secondary' }))).toBe('quote');
    expect(vaultTable('instrument', items({ symbol: 'XBTUSD' }))).toBe('instrument');
  });

  it('keeps the base name for a pooled-fanout table on Primary', () => {
    expect(vaultTable('orderBookL2', items({ symbol: 'XBTUSD', pool: 'Primary' }))).toBe('orderBookL2');
  });

  it('routes non-Primary pooled-fanout data to a lowercased per-pool pseudo-table', () => {
    expect(vaultTable('orderBookL2', items({ symbol: 'XBTUSD', pool: 'Secondary' }))).toBe('orderBookL2.secondary');
    expect(vaultTable('tradeBin1m', items({ symbol: 'XBTUSD', pool: 'Secondary' }))).toBe('tradeBin1m.secondary');
  });

  it('keeps the base name when a pooled-fanout message carries no pool (empty or untagged)', () => {
    expect(vaultTable('orderBookL2', [])).toBe('orderBookL2');
    expect(vaultTable('orderBookL2', items({ symbol: 'XBTUSD' }))).toBe('orderBookL2');
  });
});

describe('isPooledFanout', () => {
  it('recognizes base tables and per-pool pseudo-tables; rejects others', () => {
    expect(isPooledFanout('orderBookL2')).toBe(true);
    expect(isPooledFanout('orderBookL2.secondary')).toBe(true);
    expect(isPooledFanout('quoteBin5m')).toBe(true);
    expect(isPooledFanout('instrument')).toBe(false);
    expect(isPooledFanout('quote')).toBe(false);
    expect(isPooledFanout('liquidation')).toBe(false);
  });
});

describe('bucketDay', () => {
  const RECEPTION = '2026-06-23T00:00:01.500Z';

  it('buckets by the item exchange timestamp, not the reception date', () => {
    // Received just after midnight, but the event happened the previous day.
    expect(bucketDay(items({ timestamp: '2026-06-22T23:59:59.900Z' }), RECEPTION)).toBe('20260622');
  });

  it('uses the MAX item timestamp (the snapshot emission boundary), not the first', () => {
    // A partial's items carry their own last-update times in any order; the day
    // is the newest, regardless of position.
    expect(bucketDay(items(
      { timestamp: '2026-06-22T10:00:00.000Z' },   // stale item, appears first
      { timestamp: '2026-06-23T00:00:00.500Z' },   // newest — decides the day
      { timestamp: '2026-06-22T23:00:00.000Z' },
    ), RECEPTION)).toBe('20260623');
  });

  it('deltas share one timestamp, so max equals that value', () => {
    expect(bucketDay(items(
      { timestamp: '2026-06-22T23:59:59.900Z' },
      { timestamp: '2026-06-22T23:59:59.900Z' },
    ), RECEPTION)).toBe('20260622');
  });

  it('falls back to the reception date for a timeless item (no timestamp)', () => {
    expect(bucketDay(items({ orderID: 'abc', leavesQty: 1 }), RECEPTION)).toBe('20260623');
  });

  it('falls back to the reception date for an empty message', () => {
    expect(bucketDay(items(), RECEPTION)).toBe('20260623');
  });
});
