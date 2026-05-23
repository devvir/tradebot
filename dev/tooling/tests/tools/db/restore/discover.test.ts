import { describe, it, expect } from 'vitest';
import { findOverlaps } from '../../../../src/tools/db/restore/discover';
import type { RestoreTarget } from '../../../../src/tools/db/restore/types';

function t(collection: string, key: string): RestoreTarget {
  return {
    collection,
    key,
    filename: `${key}.archive.gz`,
    local:    null,
    mega:     { path: `mega:/${collection}/${key}.archive.gz`, size: 1 },
  };
}

describe('findOverlaps', () => {
  it('returns nothing for an empty list', () => {
    expect(findOverlaps([])).toEqual([]);
  });

  it('returns nothing for a single target', () => {
    expect(findOverlaps([t('quote', '2024')])).toEqual([]);
  });

  it('returns nothing for siblings of the same granularity', () => {
    expect(findOverlaps([t('quote', '2024'), t('quote', '2025')])).toEqual([]);
    expect(findOverlaps([t('quote', '202403'), t('quote', '202404')])).toEqual([]);
    expect(findOverlaps([t('quote', '20240315'), t('quote', '20240316')])).toEqual([]);
  });

  it('flags YYYY × YYYYMM in same year', () => {
    const c = findOverlaps([t('quote', '2024'), t('quote', '202403')]);
    expect(c).toEqual([{ collection: 'quote', broader: '2024', narrower: '202403' }]);
  });

  it('flags YYYY × YYYYMMDD in same year', () => {
    const c = findOverlaps([t('quote', '2024'), t('quote', '20240315')]);
    expect(c).toEqual([{ collection: 'quote', broader: '2024', narrower: '20240315' }]);
  });

  it('flags YYYYMM × YYYYMMDD in same month', () => {
    const c = findOverlaps([t('quote', '202403'), t('quote', '20240315')]);
    expect(c).toEqual([{ collection: 'quote', broader: '202403', narrower: '20240315' }]);
  });

  it('flags "all" × anything else', () => {
    const c = findOverlaps([t('quote', 'all'), t('quote', '2024')]);
    expect(c).toEqual([{ collection: 'quote', broader: 'all', narrower: '2024' }]);
  });

  it('does not cross collection boundaries', () => {
    expect(findOverlaps([t('quote', '2024'), t('trade', '202403')])).toEqual([]);
  });

  it('catches both year-vs-month and month-vs-day in one collection', () => {
    const c = findOverlaps([t('quote', '2024'), t('quote', '202403'), t('quote', '20240315')]);
    const pairs = c.map(x => `${x.broader}→${x.narrower}`).sort();
    expect(pairs).toEqual([
      '2024→202403',
      '2024→20240315',
      '202403→20240315',
    ].sort());
  });

  it('does not flag months in different years', () => {
    expect(findOverlaps([t('quote', '2024'), t('quote', '202503')])).toEqual([]);
  });

  it('does not flag days in different months', () => {
    expect(findOverlaps([t('quote', '202403'), t('quote', '20240415')])).toEqual([]);
  });
});
