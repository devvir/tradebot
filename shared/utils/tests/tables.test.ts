import { describe, it, expect } from 'vitest';
import { baseTable, POOLED_TABLES, TABLE_SPECS } from '../src/tables';

describe('baseTable', () => {
  it('strips a qualifier suffix down to the base name', () => {
    expect(baseTable('orderBookL2.secondary')).toBe('orderBookL2');
    expect(baseTable('trade.anything.else')).toBe('trade');
  });

  it('returns unqualified names unchanged', () => {
    expect(baseTable('orderBookL2')).toBe('orderBookL2');
  });
});

describe('POOLED_TABLES', () => {
  it('contains exactly the tables whose spec types carry a pool field', () => {
    for (const [table, spec] of Object.entries(TABLE_SPECS))
      expect(POOLED_TABLES.has(table)).toBe('pool' in spec.types);
  });

  it('covers the collected pooled tables and excludes instrument', () => {
    expect(POOLED_TABLES.has('orderBookL2')).toBe(true);
    expect(POOLED_TABLES.has('trade')).toBe(true);
    expect(POOLED_TABLES.has('quote')).toBe(true);
    expect(POOLED_TABLES.has('instrument')).toBe(false);
  });
});
