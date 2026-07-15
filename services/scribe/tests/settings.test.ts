import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TABLES } from '../src/utils/settings';

describe('TABLES configuration', () => {
  it('has exactly 7 tables', () => {
    expect(TABLES).toHaveLength(7);
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

    it('compositeIndex, trade, and quote define a symbols resolver', () => {
      expect(typeof byName.compositeIndex!.symbols).toBe('function');
      expect(typeof byName.trade!.symbols).toBe('function');
      expect(typeof byName.quote!.symbols).toBe('function');
    });
  });

  describe('trade / quote', () => {
    const byName = Object.fromEntries(TABLES.map((t) => [t.name, t]));

    it('collect unfiltered (no pool filter — rows carry their own pool)', () => {
      expect(byName.trade!.filter).toBeUndefined();
      expect(byName.quote!.filter).toBeUndefined();
    });

    it('both start from 2026-04-01', () => {
      expect(byName.trade!.from).toBe('20260416');
      expect(byName.quote!.from).toBe('20260414');
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
