import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TABLES, PAGE_SIZE } from '../src/utils/settings';

describe('TABLES configuration', () => {
  it('has exactly 9 tables', () => {
    expect(TABLES).toHaveLength(9);
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

  describe('per-symbol subtask resolvers', () => {
    const byName = Object.fromEntries(TABLES.map((t) => [t.name, t]));

    it('compositeIndex and quote tables define a symbols resolver; trade does not', () => {
      expect(typeof byName.compositeIndex!.symbols).toBe('function');
      expect(typeof byName.quote!.symbols).toBe('function');
      expect(typeof byName['quote.secondary']!.symbols).toBe('function');
      expect(byName.trade!.symbols).toBeUndefined();
    });
  });

  describe('trade / quote pool split', () => {
    const byName = Object.fromEntries(TABLES.map((t) => [t.name, t]));

    it('canonical tables select Primary, secondary tables select Secondary', () => {
      expect(byName.trade!.filter).toEqual({ pool: 'Primary' });
      expect(byName.quote!.filter).toEqual({ pool: 'Primary' });
      expect(byName['trade.secondary']!.filter).toEqual({ pool: 'Secondary' });
      expect(byName['quote.secondary']!.filter).toEqual({ pool: 'Secondary' });
    });

    it('both trade tables start from 2026-04-01 and drop referential prints', () => {
      for (const name of ['trade', 'trade.secondary']) {
        expect(byName[name]!.from).toBe('20260401');
        expect(byName[name]!.keep!({ size: 0 })).toBe(false);
        expect(byName[name]!.keep!({ size: 5 })).toBe(true);
      }
    });

    it('both quote tables start from 2026-04-01', () => {
      expect(byName.quote!.from).toBe('20260401');
      expect(byName['quote.secondary']!.from).toBe('20260401');
    });
  });
});

describe('TABLES — indexTickOnly filter', () => {
  // settings.ts computes compositeIndex's filter at module load from config, so
  // each branch needs the module re-evaluated against a freshly mocked config.
  beforeEach(() => { vi.resetModules(); });

  const loadTables = async (indexTickOnly: boolean) => {
    vi.doMock('../src/config', () => ({ default: { indexTickOnly, tables: [] } }));

    return (await import('../src/utils/settings')).TABLES;
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
