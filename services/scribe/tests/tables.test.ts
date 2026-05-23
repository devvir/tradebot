import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TABLES, PAGE_SIZE } from '../src/utils/tables';

describe('TABLES configuration', () => {
  it('has exactly 5 tables', () => {
    expect(TABLES).toHaveLength(5);
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

    it('tick uses /trade with a size:0 filter', () => {
      expect(byName.tick!.path).toBe('/trade');
      expect(byName.tick!.filter).toEqual({ size: 0 });
    });
  });
});

describe('TABLES — indexTickOnly filter', () => {
  // `tables.ts` computes compositeIndex's filter at module load from config, so
  // each branch needs the module re-evaluated against a freshly mocked config.
  beforeEach(() => { vi.resetModules(); });

  const loadTables = async (indexTickOnly: boolean) => {
    vi.doMock('../src/config', () => ({ default: { indexTickOnly, tables: [] } }));

    return (await import('../src/utils/tables')).TABLES;
  };

  it('compositeIndex carries the BMI filter when indexTickOnly is true', async () => {
    const compositeIndex = (await loadTables(true)).find(t => t.name === 'compositeIndex');

    expect(compositeIndex!.filter).toEqual({ reference: 'BMI' });
  });

  it('compositeIndex has no filter when indexTickOnly is false', async () => {
    const compositeIndex = (await loadTables(false)).find(t => t.name === 'compositeIndex');

    expect(compositeIndex!.filter).toBeUndefined();
  });
});
