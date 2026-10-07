import { describe, expect, it } from 'vitest';
import { levelsOf } from '../src/vocabulary';

/**
 * A dataset's levels, named on the way out.
 *
 * The catalog stores them as one string because a path is one string; a consumer
 * choosing between book depths should not be splitting commas and counting
 * positions to find them.
 */
describe('naming a variant\'s levels', () => {
  it('names each level of a multi-level variant', () => {
    expect(levelsOf('books', 'incremental,400'))
      .toEqual({ kind: 'incremental', depth: '400' });
  });

  it('names the single level of a simple one', () => {
    expect(levelsOf('klines', '1m')).toEqual({ interval: '1m' });
  });

  it('answers nothing for a dataset with no level below it', () => {
    expect(levelsOf('quotes', '')).toEqual({});
    expect(levelsOf('liquidations', '')).toEqual({});
  });

  /**
   * Most venues publish one flavour of trades and say nothing about whether it
   * is aggregated, so the catalog stores nothing — and reports `default`, which
   * claims only "the one it publishes".
   */
  it('reports the default where a level has one and nothing is stored', () => {
    expect(levelsOf('trades', '')).toEqual({ aggregation: 'default' });
  });

  it('reports what is stored where a venue does say', () => {
    expect(levelsOf('trades', 'aggregated')).toEqual({ aggregation: 'aggregated' });
    expect(levelsOf('trades', 'default')).toEqual({ aggregation: 'default' });
  });

  /** A level nobody has named yet is reported rather than silently dropped. */
  it('gives the last named level whatever is left over', () => {
    expect(levelsOf('books', 'incremental,400,surprise'))
      .toEqual({ kind: 'incremental', depth: '400,surprise' });
  });
});
