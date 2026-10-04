import { describe, expect, it } from 'vitest';
import { fileNameOf, fileOf, labelOf, monthDirOf, versionOf } from '../src/vault';
import { seriesOf } from '../src/schema/series';
import type { Partition, VaultKey } from '../src/types';

const key = (over: Partial<VaultKey> = {}): VaultKey => ({
  table: 'trades', venue: 'binance', market: 'spot', month: '2020-01', ...over,
});

const partition = (digest: string): Partition => ({
  id: 'binance|spot|trades,default|*|daily|2020-01',
  key: { venue: 'binance', market: 'spot', dataset: 'trades', variant: 'default',
    bundle: 'instrument', grain: 'daily', month: '2020-01' },
  stats: {
    files: 1, bytes: 1, digest, pending: 0,
    first: { files: 0, bytes: 0, digest: '', pending: 0 },
    last:  { files: 0, bytes: 0, digest: '', pending: 0 },
  },
});

describe('the vault layout', () => {
  /** A partition is one directory: the month, under the dataset's levels. */
  it('files a partition under its dataset levels and its month', () => {
    expect(monthDirOf(key())).toMatch(/\/venue=binance\/market=spot\/dataset=trades\/202001$/);
    expect(monthDirOf(key({ table: 'klines', interval: '1m' })))
      .toMatch(/\/dataset=klines\/interval=1m\/202001$/);
  });

  /**
   * Gate publishes funding twice — what was charged and the running estimate —
   * and they are different things, so `kind` keeps them in separate partitions.
   */
  it('separates realised from predicted funding', () => {
    const realised  = key({ table: 'funding', kind: 'realised' });
    const predicted = key({ table: 'funding', kind: 'predicted' });

    expect(monthDirOf(realised)).not.toBe(monthDirOf(predicted));
    expect(fileNameOf(realised, 'BTC_USDT')).toContain('.realised.');
    expect(labelOf(predicted)).toContain('predicted');
  });

  it('files each instrument under its letter and a symbol= level', () => {
    expect(fileOf(key(), 'BTCUSDT')).toBe('B/symbol=BTCUSDT/trades.binance.spot.BTCUSDT.202001.parquet');
    expect(fileOf(key(), '1INCHUSDT')).toMatch(/^_\/symbol=1INCHUSDT\//);
  });
});

describe('the version', () => {
  const series = seriesOf({ venue: 'binance', market: 'spot', dataset: 'trades', variant: 'default' });

  it('is the same for the same inputs', () => {
    expect(versionOf(key(), partition('a'), series, []))
      .toBe(versionOf(key(), partition('a'), series, []));
  });

  /** Whatever changed in the catalog changes the version. */
  it('changes with the partition, a neighbour\'s edge and the series', () => {
    const base = versionOf(key(), partition('a'), series, []);

    expect(versionOf(key(), partition('b'), series, [])).not.toBe(base);
    expect(versionOf(key(), partition('a'), series, ['edge'])).not.toBe(base);
    expect(versionOf(key(), partition('a'), [{ ...series[0]!, ts: 'other' }], [])).not.toBe(base);
  });

  it('is twelve hex digits', () => {
    expect(versionOf(key(), partition('a'), series, [])).toMatch(/^[0-9a-f]{12}$/);
  });
});
