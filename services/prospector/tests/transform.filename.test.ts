import { describe, expect, it } from 'vitest';
import { keyOf } from '../src/catalog/series';
import type { Publishing, Transform } from '../src/types';

/**
 * A transform that stands for a whole filename, not one segment of it.
 *
 * Bitget publishes a handful of era-1 days under era 2's name and nowhere else.
 * The era-1 pattern carries the filename in an `eraName` slot whose default is
 * its own spelling, and a row for that one day hands back era 2's — calendar
 * slots included, filled after it is substituted. See BITGET.md.
 */

const PERP = 'kline/{TRANSFORM:archiveDir:{SYMBOL}}/{TRANSFORM:eraName:{SYMBOL}_UMCBL_1min_{YYYY}{MM}{DD}}.zip';

const row = (from: string, to: string | null): Transform => ({
  venueId: 1, market: 'perp', symbol: 'XRPUSDT', dataset: 'klines',
  kind: 'eraName', transform: 'UMCBL/{YYYY}{MM}{DD}', from_: from, to_: to,
});

const series = (transforms?: Transform[]): Publishing => ({
  venueId: 1, symbol: 'XRPUSDT', urlSymbol: null, market: 'perp', dataset: 'klines', variant: '1m',
  pattern: PERP, ...(transforms ? { transforms } : {}),
}) as unknown as Publishing;

describe('a filename transform', () => {
  it('leaves every key as the default spells it where no row applies', () => {
    expect(keyOf(series(), '20200228')).toBe('kline/XRPUSDT/XRPUSDT_UMCBL_1min_20200228.zip');
  });

  it("spells one day with the row's name, slots and slashes included", () => {
    const one = series([row('20200229', '20200229')]);

    expect(keyOf(one, '20200228')).toBe('kline/XRPUSDT/XRPUSDT_UMCBL_1min_20200228.zip');
    expect(keyOf(one, '20200229')).toBe('kline/XRPUSDT/UMCBL/20200229.zip');
    expect(keyOf(one, '20200301')).toBe('kline/XRPUSDT/XRPUSDT_UMCBL_1min_20200301.zip');
  });

  /** A row for another dataset of the same instrument says nothing about klines. */
  it('ignores a row for another dataset', () => {
    const other = series([{ ...row('20200229', '20200229'), dataset: 'trades' }]);

    expect(keyOf(other, '20200229')).toBe('kline/XRPUSDT/XRPUSDT_UMCBL_1min_20200229.zip');
  });
});
