import { describe, it, expect } from 'vitest';
import { baseTable } from '../src/tables';

describe('baseTable', () => {
  it('strips a qualifier suffix down to the base name', () => {
    expect(baseTable('orderBookL2.secondary')).toBe('orderBookL2');
    expect(baseTable('trade.anything.else')).toBe('trade');
  });

  it('returns unqualified names unchanged', () => {
    expect(baseTable('orderBookL2')).toBe('orderBookL2');
  });
});
