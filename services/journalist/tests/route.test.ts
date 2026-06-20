import { describe, it, expect } from 'vitest';
import { poolTable } from '../src/route';

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
