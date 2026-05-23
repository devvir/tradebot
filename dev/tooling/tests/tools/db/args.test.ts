import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseArgs, resolveCollections, buildPairs } from '../../../src/tools/db/utils/args';

vi.mock('../../../src/shared/ui/logger', () => ({
  warn: vi.fn(),
  info: vi.fn(),
}));

// ─── parseArgs ─────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('returns empty buckets for no args', () => {
    const r = parseArgs([]);
    expect(r.dates).toEqual([]);
    expect(r.rawCollections).toEqual([]);
    expect(r.useAll).toBe(false);
  });

  it('recognises the `all` keyword regardless of case', () => {
    expect(parseArgs(['all']).useAll).toBe(true);
    expect(parseArgs(['ALL']).useAll).toBe(true);
    expect(parseArgs(['All']).useAll).toBe(true);
  });

  it('routes YYYY / YYYYMM / YYYYMMDD args to dates', () => {
    const r = parseArgs(['2026', '202504', '20240315']);
    expect(r.dates.map(d => d.key)).toEqual(['2026', '202504', '20240315']);
    expect(r.rawCollections).toEqual([]);
  });

  it('accepts dashed date variants', () => {
    const r = parseArgs(['2024-03', '2024-03-15']);
    expect(r.dates.map(d => d.key)).toEqual(['202403', '20240315']);
  });

  it('treats non-date alphanumeric args as collection names', () => {
    const r = parseArgs(['quote', 'trade']);
    expect(r.rawCollections).toEqual(['quote', 'trade']);
    expect(r.dates).toEqual([]);
  });

  it('treats numeric-but-invalid-date args as collection names', () => {
    // month 16 is invalid → not a date → treated as collection
    const r = parseArgs(['20201605']);
    expect(r.dates).toEqual([]);
    expect(r.rawCollections).toEqual(['20201605']);
  });

  it('handles a mixed arg list in any order', () => {
    const r = parseArgs(['quote', '2024', 'trade', 'all', '2025-01']);
    expect(r.useAll).toBe(true);
    expect(r.dates.map(d => d.key)).toEqual(['2024', '202501']);
    expect(r.rawCollections).toEqual(['quote', 'trade']);
  });
});

// ─── resolveCollections ────────────────────────────────────────────────────────

describe('resolveCollections', () => {
  const allNames = ['announcement', 'quote', 'trade'];

  it('returns every collection when useAll is true', () => {
    expect(resolveCollections([], true, [], allNames)).toEqual(allNames);
  });

  it('returns every collection when no raw names but dates present', () => {
    const dates = parseArgs(['2024']).dates;
    expect(resolveCollections([], false, dates, allNames)).toEqual(allNames);
  });

  it('returns nothing when no raw names and no dates', () => {
    expect(resolveCollections([], false, [], allNames)).toEqual([]);
  });

  it('filters to known names and warns on unknowns', async () => {
    const { warn } = await import('../../../src/shared/ui/logger');
    (warn as ReturnType<typeof vi.fn>).mockClear();

    const result = resolveCollections(['quote', 'bogus', 'trade'], false, [], allNames);

    expect(result).toEqual(['quote', 'trade']);
    expect(warn).toHaveBeenCalledOnce();
    expect((warn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('bogus');
  });

  it('does not warn when all names are known', async () => {
    const { warn } = await import('../../../src/shared/ui/logger');
    (warn as ReturnType<typeof vi.fn>).mockClear();

    resolveCollections(['quote'], false, [], allNames);

    expect(warn).not.toHaveBeenCalled();
  });
});

// ─── buildPairs ────────────────────────────────────────────────────────────────

describe('buildPairs', () => {
  it('one null-date pair per collection when no dates', () => {
    const pairs = buildPairs(['quote', 'trade'], []);
    expect(pairs).toEqual([
      { collection: 'quote', date: null },
      { collection: 'trade', date: null },
    ]);
  });

  it('cartesian product of collections × dates', () => {
    const dates = parseArgs(['2024', '2025']).dates;
    const pairs = buildPairs(['quote', 'trade'], dates);

    expect(pairs).toHaveLength(4);
    expect(pairs.map(p => `${p.collection}/${p.date?.key}`)).toEqual([
      'quote/2024', 'quote/2025', 'trade/2024', 'trade/2025',
    ]);
  });

  it('returns empty when no collections', () => {
    expect(buildPairs([], parseArgs(['2024']).dates)).toEqual([]);
    expect(buildPairs([], [])).toEqual([]);
  });
});
