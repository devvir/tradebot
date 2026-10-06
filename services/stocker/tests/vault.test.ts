import { describe, expect, it } from 'vitest';
import { bundleOf, fileOf, isWhole, labelOf, revisionOf, sliceDirOf } from '../src/vault';
import { seriesOf } from '../src/schema/series';
import type { Partition, VaultKey } from '../src/types';

const key = (over: Partial<VaultKey> = {}): VaultKey => ({
  table: 'trades', venue: 'binance', market: 'spot', month: '2020-01', ...over,
});

const partition = (version: string, month = '2020-01'): Partition => ({
  id: `binance|spot|trades,default|*|daily|${month}`,
  key: { venue: 'binance', market: 'spot', dataset: 'trades', variant: 'default',
    bundle: 'instrument', grain: 'daily', month },
  files: 1, bytes: 1, pending: 0, version, updatedAt: '2020-02-01T00:00:00.000Z',
});

describe('the vault layout', () => {
  it('files a slice under its dataset levels', () => {
    expect(sliceDirOf(key())).toMatch(/\/venue=binance\/market=spot\/dataset=trades$/);
    expect(sliceDirOf(key({ table: 'klines', interval: '1m' }))).toMatch(/\/dataset=klines\/interval=1m$/);
  });

  /**
   * Gate publishes funding twice — what was charged and the running estimate —
   * and they are different things, so `kind` keeps them in separate slices.
   */
  it('separates realised from predicted funding', () => {
    const realised  = key({ table: 'funding', kind: 'realised' });
    const predicted = key({ table: 'funding', kind: 'predicted' });

    expect(sliceDirOf(realised)).not.toBe(sliceDirOf(predicted));
    expect(labelOf(predicted)).toContain('predicted');
  });

  /** A month is the whole of a file's name, in either form: stocked again, it is found where it was. */
  it('names a file by its month, and by the side it holds of it', () => {
    expect(bundleOf(key())).toMatch(/\/dataset=trades\/@\/202001\.parquet$/);
    expect(fileOf(key(), 'BTCUSDT')).toMatch(/\/dataset=trades\/BTCUSDT\/202001\.parquet$/);
    expect(bundleOf(key(), 'post')).toMatch(/\/dataset=trades\/@\/202001\.post\.parquet$/);
    expect(fileOf(key(), 'BTCUSDT', 'pre')).toMatch(/\/dataset=trades\/BTCUSDT\/202001\.pre\.parquet$/);
  });
});

describe('what counts as stocked', () => {
  it('is one file for every instrument, or files under the symbols', () => {
    expect(isWhole({ bundle: true, symbols: [], sides: [] })).toBe(true);
    expect(isWhole({ bundle: false, symbols: ['BTCUSDT'], sides: [] })).toBe(true);
  });

  it('is not a month the vault holds nothing of, or only a neighbour\'s hours of', () => {
    expect(isWhole(undefined)).toBe(false);
    expect(isWhole({ bundle: false, symbols: [], sides: [] })).toBe(false);
    expect(isWhole({ bundle: false, symbols: [], sides: [{ symbol: '@', side: 'post' }] })).toBe(false);
  });
});

describe('the revision', () => {
  const series = seriesOf({ venue: 'binance', market: 'spot', dataset: 'trades', variant: 'default' });

  it('is the same for the same inputs', () => {
    expect(revisionOf(key(), partition('a'), series, []))
      .toBe(revisionOf(key(), partition('a'), series, []));
  });

  /** Whatever changed in the catalog changes the revision. */
  it('changes with the partition\'s version, a neighbour\'s and the series', () => {
    const base      = revisionOf(key(), partition('a'), series, []);
    const neighbour = (version: string) => [{ partition: partition(version, '2020-02'), side: 'first' as const }];

    expect(revisionOf(key(), partition('b'), series, [])).not.toBe(base);
    expect(revisionOf(key(), partition('a'), series, neighbour('n'))).not.toBe(base);
    expect(revisionOf(key(), partition('a'), series, neighbour('n')))
      .not.toBe(revisionOf(key(), partition('a'), series, neighbour('m')));
    expect(revisionOf(key(), partition('a'), [{ ...series[0]!, ts: 'other' }], [])).not.toBe(base);
  });

  it('is twelve hex digits', () => {
    expect(revisionOf(key(), partition('a'), series, [])).toMatch(/^[0-9a-f]{12}$/);
  });
});
