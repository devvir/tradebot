import { describe, expect, it } from 'vitest';
import { _test_preferred, _test_required, sizeOf } from '../src/plan';
import type { Shape } from '../src/types';

/**
 * Turning a requirement into a choice, against what a venue actually publishes.
 *
 * **The point of every case here is that the want does not change.** *The
 * smallest interval, monthly if there is a choice, the venue-wide file if there
 * is one* has to keep meaning the right thing when a venue drops an interval,
 * stops publishing monthly, or has no bucket at all — because the alternative is
 * a list that silently fetches nothing the day a venue rearranges itself.
 */

const shape = (over: Partial<Shape> = {}): Shape => ({
  market: 'perp', dataset: 'klines', variant: { interval: '1m' }, grain: 'monthly',
  patterns: 1, symbols: 100, buckets: 0, first: '202101', last: null, ...over,
});

/** How a set of shapes reads, shortest way to assert on one. */
const label = (shapes: readonly Shape[]): string[] =>
  shapes.map(one => `${Object.values(one.variant).join(',')}/${one.grain}`
    + (one.buckets > 0 ? '/@' : '')).sort();

const klines = [
  shape({ variant: { interval: '1m' },  grain: 'monthly' }),
  shape({ variant: { interval: '5m' },  grain: 'monthly' }),
  shape({ variant: { interval: '1h' },  grain: 'monthly' }),
  shape({ variant: { interval: '1d' },  grain: 'daily' }),
];

describe('a fixed requirement is this or nothing', () => {
  it('keeps only what matches', () => {
    expect(label(_test_required(klines, { interval: '5m' }))).toEqual(['5m/monthly']);
  });

  /** Not "or something like it" — a caller who named a depth meant that depth. */
  it('keeps nothing when the venue does not publish it', () => {
    expect(_test_required(klines, { interval: '3s' })).toEqual([]);
  });

  it('composes, so several requirements all hold', () => {
    expect(label(_test_required(klines, { interval: '1m', grain: 'monthly' })))
      .toEqual(['1m/monthly']);
    expect(_test_required(klines, { interval: '1m', grain: 'daily' })).toEqual([]);
  });
});

describe('a preference narrows only where it can', () => {
  it('takes the smallest interval there is', () => {
    expect(label(_test_preferred(klines, { interval: 'min' }))).toEqual(['1m/monthly']);
  });

  it('takes the largest where that is what was asked', () => {
    expect(label(_test_preferred(klines, { interval: 'max' }))).toEqual(['1d/daily']);
  });

  /**
   * The whole reason a preference is not a filter: a venue that stops publishing
   * monthly must fall through to daily rather than to nothing.
   */
  it('leaves the field alone when nothing satisfies it', () => {
    const daily = [shape({ grain: 'daily' })];

    expect(label(_test_preferred(daily, { grain: 'monthly' }))).toEqual(['1m/daily']);
  });

  /** Key order is priority order, and the first one written wins. */
  it('gives up the second preference to honour the first', () => {
    const mixed = [
      shape({ variant: { interval: '1m' }, grain: 'daily' }),
      shape({ variant: { interval: '1h' }, grain: 'monthly' }),
    ];

    expect(label(_test_preferred(mixed, { interval: 'min', grain: 'monthly' })))
      .toEqual(['1m/daily']);
    expect(label(_test_preferred(mixed, { grain: 'monthly', interval: 'min' })))
      .toEqual(['1h/monthly']);
  });

  /**
   * A tie is not broken here. Two shapes at the same interval stay candidates so
   * that the next preference can decide between them.
   */
  it('keeps ties for the next preference to settle', () => {
    const both = [
      shape({ variant: { interval: '1m' }, grain: 'monthly' }),
      shape({ variant: { interval: '1m' }, grain: 'daily' }),
      shape({ variant: { interval: '1h' }, grain: 'monthly' }),
    ];

    expect(label(_test_preferred(both, { interval: 'min' })))
      .toEqual(['1m/daily', '1m/monthly']);
    expect(label(_test_preferred(both, { interval: 'min', grain: 'monthly' })))
      .toEqual(['1m/monthly']);
  });

  /** A mode is not larger or smaller than another mode. */
  it('ignores min on a level that has no size', () => {
    const books = [
      shape({ dataset: 'books', variant: { depth: '400', mode: 'incremental' } }),
      shape({ dataset: 'books', variant: { depth: '50', mode: 'snapshot' } }),
    ];

    expect(label(_test_preferred(books, { mode: 'min' })))
      .toEqual(['400,incremental', '50,snapshot'].map(one => `${one}/monthly`).sort());
  });

  it('takes the shallowest book where depth is what is being compared', () => {
    const books = [
      shape({ dataset: 'books', variant: { depth: '400', mode: 'incremental' } }),
      shape({ dataset: 'books', variant: { depth: '50', mode: 'snapshot' } }),
    ];

    expect(label(_test_preferred(books, { depth: 'min' }))).toEqual(['50,snapshot/monthly']);
  });
});

/**
 * The case that started this: okx publishes a venue-wide file daily and
 * per-instrument files monthly, so preferring the bucket means giving up the
 * monthly rendering — and that is the right answer, since one file beats two
 * thousand.
 */
describe('choosing the venue-wide file', () => {
  const okx = [
    shape({ dataset: 'trades', variant: {}, grain: 'daily', symbols: 0, buckets: 1 }),
    shape({ dataset: 'trades', variant: {}, grain: 'monthly', symbols: 635, buckets: 0 }),
  ];

  it('prefers the bucket over the preferred grain', () => {
    expect(label(_test_preferred(okx, { scope: 'bucket', grain: 'monthly' })))
      .toEqual(['/daily/@']);
  });

  it('falls back to the per-instrument files where there is no bucket', () => {
    const none = [shape({ dataset: 'trades', variant: {}, grain: 'monthly', buckets: 0 })];

    expect(label(_test_preferred(none, { scope: 'bucket' }))).toEqual(['/monthly']);
  });
});

/**
 * Sizes exist for one purpose — ordering — so anything that cannot be ordered
 * has none, and that is an answer rather than a failure.
 */
describe('what a level is worth', () => {
  it('reads durations, longest suffix first', () => {
    expect(sizeOf('1m')).toBe(60);
    expect(sizeOf('3m')).toBe(180);
    expect(sizeOf('1h')).toBe(3_600);
    expect(sizeOf('1mo')).toBeGreaterThan(sizeOf('1w')!);
  });

  it('orders every kline interval a venue publishes', () => {
    const sorted = ['1mo', '1w', '3d', '1d', '8h', '1h', '30m', '5m', '1m', '10s']
      .map(one => sizeOf(one)!);

    expect([...sorted].sort((a, b) => b - a)).toEqual(sorted);
  });

  it('reads a bare number as a depth', () => {
    expect(sizeOf('400')).toBe(400);
    expect(sizeOf('50')).toBe(50);
  });

  /** An unbinned series carries every event rather than a summary of a span. */
  it('sorts ticks below any bar', () => {
    expect(sizeOf('ticks')).toBe(0);
    expect(sizeOf('ticks')!).toBeLessThan(sizeOf('1s')!);
  });

  it('has no size for what cannot be ordered', () => {
    expect(sizeOf('incremental')).toBeUndefined();
    expect(sizeOf('aggregated')).toBeUndefined();
    expect(sizeOf('full')).toBeUndefined();
    expect(sizeOf(undefined)).toBeUndefined();
  });
});
