import { describe, expect, it } from 'vitest';
import {
  _test_describe as describeFilter,
  _test_group as group,
  _test_matches as matches,
  _test_span as span,
} from '../../../src/tools/cold/evict/vault';
import type { SourceFile, VaultFilter } from '../../../src/tools/cold/types';

/**
 * The vault is evicted by selection, so the filter is what stands between a
 * request to reclaim four symbols and a request to reclaim the vault. These are
 * the tests for what it must **not** match.
 */
const filter = (over: Partial<VaultFilter> = {}): VaultFilter =>
  ({ venues: [], markets: [], datasets: [], symbols: [], periods: [], ...over });

const partition = (over: Partial<SourceFile> = {}): SourceFile => ({
  path:    'dataset=trades/venue=binance/market=futures/symbol=ETHUSD/trades.binance.futures.ETHUSD.201803.parquet',
  bytes:   100,
  mtime:   1,
  venue:   'binance',
  month:   '201803',
  market:  'futures',
  symbol:  'ETHUSD',
  dataset: 'trades',
  variant: null,
  ...over,
});

describe('selecting which partitions an eviction is about', () => {
  it('matches everything when nothing is named', () => {
    expect(matches(partition(), filter())).toBe(true);
  });

  it('takes every named dimension together, not any of them', () => {
    const wanted = filter({ venues: ['binance'], datasets: ['klines'] });

    expect(matches(partition(), wanted)).toBe(false);
    expect(matches(partition({ dataset: 'klines' }), wanted)).toBe(true);
  });

  it('compares case-insensitively, since the filter is typed and the tree is not', () => {
    expect(matches(partition(), filter({ symbols: ['ethusd'] }))).toBe(true);
    expect(matches(partition({ venue: 'BitGet' }), filter({ venues: ['bitget'] }))).toBe(true);
  });

  /**
   * The dangerous direction. `BTC` catching `BTCUSDT` would be convenient for
   * "keep BTC and ETH" and would delete far more than was asked for in the
   * inverse, so symbols match whole or not at all.
   */
  it('never matches a symbol by prefix', () => {
    expect(matches(partition({ symbol: 'ETHUSDT' }), filter({ symbols: ['ethusd'] }))).toBe(false);
    expect(matches(partition({ symbol: 'XBTUSD' }), filter({ symbols: ['btc'] }))).toBe(false);
  });

  it('reads a period as a prefix, so a year and a month are the same test', () => {
    expect(matches(partition(), filter({ periods: ['2018'] }))).toBe(true);
    expect(matches(partition(), filter({ periods: ['201803'] }))).toBe(true);
    expect(matches(partition(), filter({ periods: ['201804'] }))).toBe(false);
    expect(matches(partition(), filter({ periods: ['2019'] }))).toBe(false);
  });

  it('takes any of the periods named', () => {
    expect(matches(partition(), filter({ periods: ['2017', '2018', '2019'] }))).toBe(true);
    expect(matches(partition(), filter({ periods: ['2017', '2019'] }))).toBe(false);
  });

  it('never matches an attribute the tree does not carry', () => {
    expect(matches(partition({ symbol: null }), filter({ symbols: ['ethusd'] }))).toBe(false);
  });
});

describe('stating the selection back', () => {
  it('names only what was asked for', () => {
    expect(describeFilter(filter({ venues: ['binance'], symbols: ['ethusd'] })))
      .toBe('venue=binance · symbol=ethusd');
  });

  it('says so plainly when nothing narrows it', () => {
    expect(describeFilter(filter())).toBe('the whole vault');
  });
});

describe('grouping what is going', () => {
  it('groups by venue and dataset, and totals each', () => {
    const groups = group([
      partition({ bytes: 10 }),
      partition({ bytes: 20, dataset: 'klines' }),
      partition({ bytes: 30, venue: 'bybit' }),
      partition({ bytes: 40 }),
    ]);

    expect(groups.map(entry => entry.label))
      .toEqual(['binance/klines', 'binance/trades', 'bybit/trades']);
    expect(groups.map(entry => entry.bytes)).toEqual([20, 50, 30]);
    expect(groups[1]!.files).toHaveLength(2);
  });
});

describe('the range a group spans', () => {
  const at = (month: string): string => `dataset=trades/trades.binance.futures.ETHUSD.${month}.parquet`;

  it('reads the months off the filenames', () => {
    expect(span([at('201812'), at('201703'), at('202001')])).toBe('201703 → 202001');
  });

  it('says one month once', () => {
    expect(span([at('201703')])).toBe('201703');
  });

  it('says nothing rather than guessing when no filename carries one', () => {
    expect(span(['dataset=trades/odd.parquet'])).toBe('');
  });
});
