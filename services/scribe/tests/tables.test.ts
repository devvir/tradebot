import { describe, it, expect } from 'vitest';
import { TABLES, PAGE_SIZE } from '../src/utils/tables';

describe('TABLES configuration', () => {
  it('has exactly 4 tables', () => {
    expect(TABLES).toHaveLength(4);
  });

  it('PAGE_SIZE is 500', () => {
    expect(PAGE_SIZE).toBe(500);
  });

  it('every table has a name, a path starting with /, and a maxStart', () => {
    for (const table of TABLES) {
      expect(typeof table.name).toBe('string');
      expect(table.name.length).toBeGreaterThan(0);
      expect(typeof table.path).toBe('string');
      expect(table.path.startsWith('/')).toBe(true);
      expect(table.maxStart === null || typeof table.maxStart === 'number').toBe(true);
    }
  });

  it('all table names are unique', () => {
    const names = TABLES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  describe('per-table paths', () => {
    const byName = Object.fromEntries(TABLES.map((t) => [t.name, t]));

    it('compositeIndex uses /instrument/compositeIndex', () => {
      expect(byName.compositeIndex!.path).toBe('/instrument/compositeIndex');
    });

    it('funding uses /funding', () => {
      expect(byName.funding!.path).toBe('/funding');
    });

    it('insurance uses /insurance', () => {
      expect(byName.insurance!.path).toBe('/insurance');
    });

    it('settlement uses /settlement', () => {
      expect(byName.settlement!.path).toBe('/settlement');
    });
  });
});
