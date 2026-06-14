import { describe, it, expect } from 'vitest';
import { computeMegaTip } from '../../../src/tools/db/utils/mega';

function files(...keys: string[]): Set<string> {
  return new Set(keys.map(k => `${k}.archive.gz`));
}

describe('computeMegaTip', () => {
  it('returns null for an empty listing', () => {
    expect(computeMegaTip(new Set())).toBeNull();
  });

  it('returns null when only non-date files are present', () => {
    expect(computeMegaTip(files('all'))).toBeNull();
  });

  it('returns the only year when only one year is backed up', () => {
    expect(computeMegaTip(files('2014'))).toBe('2014');
  });

  it('returns the latest contiguous year', () => {
    expect(computeMegaTip(files('2014', '2015', '2016', '2017', '2018', '2019'))).toBe('2019');
  });

  it('stops at a year gap', () => {
    // user-provided example: 2014-2019 then nothing then 2021 → "2019"
    expect(computeMegaTip(files('2014', '2015', '2016', '2017', '2018', '2019', '2021'))).toBe('2019');
  });

  it('falls into months of the first incomplete year', () => {
    expect(computeMegaTip(files('2014', '2015', '201601', '201602', '201603'))).toBe('2016-03');
  });

  it('stops at a month gap inside the first incomplete year', () => {
    // 201602, 201603 with no 201601 → no contiguous run from Jan → fall back to last complete year
    expect(computeMegaTip(files('2014', '2015', '201602', '201603'))).toBe('2015');
  });

  it('treats 12 contiguous months as a complete year', () => {
    const months = Array.from({ length: 12 }, (_, i) => `2015${String(i + 1).padStart(2, '0')}`);
    expect(computeMegaTip(files('2014', ...months))).toBe('2015');
  });

  it('prefers year-level completeness over month-level when both could apply', () => {
    // 2015 year + 201501..201503 — year wins, so tip = 2015 (not 2015-03)
    expect(computeMegaTip(files('2014', '2015', '201501', '201502', '201503'))).toBe('2015');
  });

  it('returns the month tip when nothing higher is complete', () => {
    expect(computeMegaTip(files('201501', '201502'))).toBe('2015-02');
  });

  it('returns the contiguous month run when backups begin mid-year', () => {
    // no complete year precedes, so the run starts at the earliest month present
    expect(computeMegaTip(files('201502', '201503'))).toBe('2015-03');
  });

  it('returns the tip for a single mid-year archive (quote.secondary case)', () => {
    expect(computeMegaTip(files('202604'))).toBe('2026-04');
  });

  it('stops at a gap within a mid-year run', () => {
    // starts at the earliest present month (April), April–May contiguous, July gapped
    expect(computeMegaTip(files('202604', '202605', '202607'))).toBe('2026-05');
  });

  it('ignores YYYYMMDD (day) keys for tip computation', () => {
    // day-only listing leaves nothing complete at year or month granularity
    expect(computeMegaTip(files('20140315', '20140316'))).toBeNull();
  });
});
