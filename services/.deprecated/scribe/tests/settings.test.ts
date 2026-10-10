import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TABLES } from '../src/utils/settings';

describe('TABLES configuration', () => {
  it('has exactly 15 tables', () => {
    expect(TABLES).toHaveLength(15);
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

  describe('bin tables', () => {
    const byName   = Object.fromEntries(TABLES.map((t) => [t.name, t]));
    const binNames = ['1m', '5m', '1h', '1d'].flatMap(s => [`tradeBin${s}`, `quoteBin${s}`]);

    it('defines all four resolutions for both trade and quote', () => {
      for (const name of binNames) expect(byName[name]).toBeDefined();
    });

    it('hits the bucketed endpoint of its source table', () => {
      expect(byName.tradeBin1m!.path).toBe('/trade/bucketed');
      expect(byName.quoteBin1h!.path).toBe('/quote/bucketed');
    });

    it('carries its binSize as a query param', () => {
      expect(byName.tradeBin5m!.params).toEqual({ binSize: '5m', pool: 'Primary' });
      expect(byName.quoteBin1d!.params).toEqual({ binSize: '1d', pool: 'Primary' });
    });

    // Unpinned, BitMEX switches the bars from Primary to Aggregated on 2026-03-04.
    it('pins the Primary pool on every bin table', () => {
      for (const name of binNames) expect(byName[name]!.params!['pool']).toBe('Primary');
    });

    // One task per table, unfiltered — BitMEX returns every symbol's bars on the
    // same clock, so there is nothing to gain from a per-symbol fan-out.
    it('runs as a single task, not per symbol', () => {
      for (const name of binNames) expect(byName[name]!.symbols).toBeUndefined();
    });

    // Bins exist only over REST (back to 2014-11-22) — no S3 history to defer to,
    // so nothing floors their start date the way it does raw trade/quote.
    it('has no `from` floor', () => {
      for (const name of binNames) expect(byName[name]!.from).toBeUndefined();
    });

    it('sorts on timestamp (no tsField override)', () => {
      for (const name of binNames) expect(byName[name]!.tsField).toBeUndefined();
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
