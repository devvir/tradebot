import { describe, expect, it } from 'vitest';
import { ALL, holds, union, without } from '../src/lenses/spans';
import type { LensSpan } from '../src/types';

/**
 * The arithmetic a lens's rules are composed with.
 *
 * **This is where "everything up to a date, except books, except recent trades"
 * either works or quietly lies.** Every other part of a lens is a set of strings
 * matched against a column; this part has to survive a rule carving a hole in the
 * middle of another rule's range.
 */

const span = (from: string | null, to: string | null): LensSpan => ({ from, to });

describe('adding time', () => {
  it('starts from nothing', () => {
    expect(union([], ALL)).toEqual([{ from: null, to: null }]);
  });

  it('keeps two spans apart where they share no day', () => {
    const out = union(union([], span('201901', '201912')), span('202101', '202112'));

    expect(out).toEqual([
      { from: '201901', to: '201912' },
      { from: '202101', to: '202112' },
    ]);
  });

  it('merges spans that overlap', () => {
    const out = union(union([], span('201901', '202006')), span('202001', '202012'));

    expect(out).toEqual([{ from: '201901', to: '202012' }]);
  });

  it('treats an open end as beyond every date', () => {
    const out = union(union([], span('201901', '201912')), span('201906', null));

    expect(out).toEqual([{ from: '201901', to: null }]);
  });
});

describe('taking time away', () => {
  /** The case the module exists for. */
  it('splits a span when the cut falls inside it', () => {
    const out = without(union([], span('201901', '202112')), span('202001', '202012'));

    expect(out).toEqual([
      { from: '201901', to: '201912' },
      { from: '202101', to: '202112' },
    ]);
  });

  it('trims rather than splits when the cut reaches an edge', () => {
    expect(without(union([], span('201901', '202112')), span('202101', null)))
      .toEqual([{ from: '201901', to: '202012' }]);

    expect(without(union([], span('201901', '202112')), span(null, '201912')))
      .toEqual([{ from: '202001', to: '202112' }]);
  });

  it('swallows a span the cut covers entirely', () => {
    expect(without(union([], span('201901', '201912')), ALL)).toEqual([]);
  });

  it('leaves a span the cut never touches', () => {
    expect(without(union([], span('201901', '201912')), span('202101', '202112')))
      .toEqual([{ from: '201901', to: '201912' }]);
  });

  /**
   * **Bounds are inclusive**, so the excluded month must not survive and the ones
   * either side of it must — at whatever grain the files are.
   */
  it('excludes the cut itself and nothing more', () => {
    const out = without(union([], ALL), span('202006', '202006'));

    expect(holds(out, '202005')).toBe(true);
    expect(holds(out, '202006')).toBe(false);
    expect(holds(out, '202007')).toBe(true);

    // And the days of that month go with it.
    expect(holds(out, '20200615')).toBe(false);
    expect(holds(out, '20200531')).toBe(true);
    expect(holds(out, '20200701')).toBe(true);
  });

  it('steps a whole month either side of a cut', () => {
    expect(without(union([], ALL), span('202006', null)))
      .toEqual([{ from: null, to: '202005' }]);
  });
});

describe('what a lens lets through', () => {
  it('answers for a date against every span it holds', () => {
    const out = without(union([], span('201901', '202112')), span('202001', '202012'));

    expect(holds(out, '201907')).toBe(true);
    expect(holds(out, '202007')).toBe(false);
    expect(holds(out, '202107')).toBe(true);
    expect(holds(out, '202201')).toBe(false);
  });

  /**
   * **A bound is a month and a file may be a day**, so the upper bound is widened
   * rather than the date narrowed: `20201215` is inside `to: 202012`, which the
   * raw strings deny because the shorter one sorts first.
   */
  it('lets every day of the bounding month through', () => {
    const upto = [{ from: null, to: '202012' }];

    expect(holds(upto, '202012')).toBe(true);
    expect(holds(upto, '20201215')).toBe(true);
    expect(holds(upto, '20201231')).toBe(true);
    expect(holds(upto, '202101')).toBe(false);
    expect(holds(upto, '20210101')).toBe(false);
  });

  it('lets a month through where the span holds it', () => {
    expect(holds([{ from: null, to: '202012' }], '202006')).toBe(true);
    expect(holds([{ from: null, to: '202012' }], '202106')).toBe(false);
  });

  it('holds nothing where there are no spans', () => {
    expect(holds([], '202001')).toBe(false);
  });
});
