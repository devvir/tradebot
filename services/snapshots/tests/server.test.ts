import { describe, it, expect } from 'vitest';
import type { SnapshotIndexedData } from '../src/types';

describe('snapshot server', () => {
  it('converts indexed table (Map) to array in response', () => {
    const indexedData: SnapshotIndexedData = new Map();
    indexedData.set('1', { id: 1, side: 'Buy', size: 100 });
    indexedData.set('2', { id: 2, side: 'Sell', size: 200 });

    const snapshot = {
      table: 'orderBookL2',
      action: 'partial' as const,
      keys: ['id'],
      data: indexedData,
      counter: 42,
      publishedAt: '2026-03-15T10:00:00Z',
    };

    let responseData = snapshot.data;
    if (snapshot.keys.length) {
      responseData = [...(snapshot.data as SnapshotIndexedData).values()];
    }

    expect(Array.isArray(responseData)).toBe(true);
    expect(responseData).toHaveLength(2);
  });

  it('keeps non-indexed table (array) as-is in response', () => {
    const arrayData = [
      { id: 1, price: 50000 },
      { id: 2, price: 50001 },
    ];

    const snapshot = {
      table: 'trade',
      action: 'insert' as const,
      keys: [],
      data: arrayData,
      counter: 42,
      publishedAt: '2026-03-15T10:00:00Z',
    };

    let responseData = snapshot.data;
    if (snapshot.keys.length) {
      responseData = [...(snapshot.data as SnapshotIndexedData).values()];
    }

    expect(Array.isArray(responseData)).toBe(true);
    expect(responseData).toEqual(arrayData);
  });
});
