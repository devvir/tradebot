import { describe, it, expect } from 'vitest';
import { poolTable, bucketDay } from '../src/route';
import type { BitmexDataItem } from '../src/types';

const items = (...d: Record<string, unknown>[]): BitmexDataItem[] => d as BitmexDataItem[];

describe('poolTable', () => {
  it('keeps the base table when no pool is given', () => {
    expect(poolTable('orderBookL2')).toBe('orderBookL2');
  });

  it('keeps the base table for an empty pool header', () => {
    expect(poolTable('orderBookL2', '')).toBe('orderBookL2');
  });

  it('keeps the base table for the Primary pool', () => {
    expect(poolTable('orderBookL2', 'Primary')).toBe('orderBookL2');
  });

  it('suffixes a non-Primary pool, lowercased', () => {
    expect(poolTable('orderBookL2', 'Secondary')).toBe('orderBookL2.secondary');
    expect(poolTable('trade', 'Aggregated')).toBe('trade.aggregated');
  });

  it('honours any pool value without knowing the table — validity is upstream\'s concern', () => {
    expect(poolTable('chat', 'Secondary')).toBe('chat.secondary');
    expect(poolTable('instrument', 'SomeFuturePool')).toBe('instrument.somefuturepool');
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
