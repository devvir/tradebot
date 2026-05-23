import { describe, it, expect } from 'vitest';
import { pairKey, pairFilename } from '../../../src/tools/db/types';
import { parseDateRange } from '../../../src/tools/db/utils/dates';

const date2024 = parseDateRange('2024');

describe('pairKey', () => {
  it('uses date.key for dated pairs', () => {
    expect(pairKey({ collection: 'quote', date: date2024 })).toBe('quote|2024');
  });

  it('uses "all" for null-date pairs', () => {
    expect(pairKey({ collection: 'quote', date: null })).toBe('quote|all');
  });

  it('produces distinct keys for different collections', () => {
    expect(pairKey({ collection: 'quote', date: date2024 }))
      .not.toBe(pairKey({ collection: 'trade', date: date2024 }));
  });

  it('produces distinct keys for different dates', () => {
    expect(pairKey({ collection: 'quote', date: date2024 }))
      .not.toBe(pairKey({ collection: 'quote', date: parseDateRange('2025') }));
  });
});

describe('pairFilename', () => {
  it('uses .archive.gz extension (mongodump format)', () => {
    expect(pairFilename({ collection: 'quote', date: date2024 })).toBe('2024.archive.gz');
  });

  it('uses date.key as the basename for dated pairs', () => {
    expect(pairFilename({ collection: 'quote', date: parseDateRange('2024-03-15') })).toBe('20240315.archive.gz');
    expect(pairFilename({ collection: 'quote', date: parseDateRange('202504') })).toBe('202504.archive.gz');
  });

  it('uses "all" for null-date pairs', () => {
    expect(pairFilename({ collection: 'quote', date: null })).toBe('all.archive.gz');
  });
});
