import { describe, it, expect } from 'vitest';
import { _test_tableBoundary as tableBoundary } from '../../../src/distillers/instrument/boundary';

/** Build a marker list from `[date, done]` tuples. */
const markers = (...rows: [string, boolean][]): { date: string; done: boolean }[] =>
  rows.map(([date, done]) => ({ date, done }));

describe('tableBoundary — furthest done date gates', () => {
  it('returns the day after the furthest done date', () => {
    expect(tableBoundary(markers(['20190401', true], ['20190402', true]))).toBe('2019-04-03');
  });

  it('ignores marker order — the max done date wins', () => {
    expect(tableBoundary(markers(['20190405', true], ['20190401', true]))).toBe('2019-04-06');
  });

  it('treats holes below the frontier as real gaps, not waits', () => {
    /** 04-02..04-04 absent (never published) — still processes up to 04-05. */
    expect(tableBoundary(markers(['20190401', true], ['20190405', true]))).toBe('2019-04-06');
  });

  it('does not let a pending date extend the frontier', () => {
    /** 04-02 mid-import → frontier stays at 04-01. */
    expect(tableBoundary(markers(['20190401', true], ['20190402', false]))).toBe('2019-04-02');
  });

  it('ignores a pending date below the furthest done date', () => {
    /** Late back-fill of 04-01 in progress, but 04-02 already done. */
    expect(tableBoundary(markers(['20190401', false], ['20190402', true]))).toBe('2019-04-03');
  });

  it('does not gate when the table has no done markers', () => {
    expect(tableBoundary(markers())).toBe('9999-12-31');
    expect(tableBoundary(markers(['20190401', false]))).toBe('9999-12-31');
  });

  it('crosses month and year boundaries correctly', () => {
    expect(tableBoundary(markers(['20191231', true]))).toBe('2020-01-01');
  });
});
