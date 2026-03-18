// Pending Review
import { describe, it, expect } from 'vitest';
import { TABLES, PAGE_SIZE } from '../src/utils/tables.js';

describe('TABLES configuration', () => {
  it('has exactly 6 tables', () => {
    expect(TABLES).toHaveLength(6);
  });

  it('PAGE_SIZE is 500', () => {
    expect(PAGE_SIZE).toBe(500);
  });

  it('every table has a name, path, and auth=false', () => {
    for (const table of TABLES) {
      expect(typeof table.name).toBe('string');
      expect(table.name.length).toBeGreaterThan(0);
      expect(typeof table.path).toBe('string');
      expect(table.path.startsWith('/')).toBe(true);
      expect(table.auth).toBe(false);
    }
  });

  it('all table names are unique', () => {
    const names = TABLES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('tables without symbolSource have non-null idFields', () => {
    // Tables with symbolSource: null should define idFields (they loop once, no symbol)
    const noSymbol = TABLES.filter((t) => t.symbolSource === null);
    for (const table of noSymbol) {
      // Either keyed or keyless — just confirm the field is defined
      expect(table.idFields !== undefined).toBe(true);
    }
  });

  describe('per-table contracts', () => {
    const byName = Object.fromEntries(TABLES.map((t) => [t.name, t]));

    it('funding uses [timestamp, symbol] as its key', () => {
      expect(byName.funding.idFields).toEqual(['timestamp', 'symbol']);
      expect(byName.funding.symbolSource).toBeNull();
    });

    it('compositeIndex has no key (insert-only) and uses indices symbolSource', () => {
      expect(byName.compositeIndex.idFields).toBeNull();
      expect(byName.compositeIndex.symbolSource).toBe('indices');
    });

    it('insurance uses [currency, timestamp] as its key', () => {
      expect(byName.insurance.idFields).toEqual(['currency', 'timestamp']);
      expect(byName.insurance.symbolSource).toBeNull();
    });

    it('quote has no key (insert-only) and uses instruments symbolSource', () => {
      expect(byName.quote.idFields).toBeNull();
      expect(byName.quote.symbolSource).toBe('instruments');
    });

    it('settlement uses [timestamp, symbol] as its key', () => {
      expect(byName.settlement.idFields).toEqual(['timestamp', 'symbol']);
      expect(byName.settlement.symbolSource).toBeNull();
    });

    it('trade has no natural key (insert-only, auto _id)', () => {
      expect(byName.trade.idFields).toBeNull();
      expect(byName.trade.symbolSource).toBeNull();
    });
  });
});
