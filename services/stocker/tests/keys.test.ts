import { describe, expect, it } from 'vitest';
import { edgesOf, idOf, monthShift, neighbourOf, parseKey, partitionOf } from '../src/keys';

describe('reading a catalog key', () => {
  it('reads every attribute of a partition off the name', () => {
    const file = parseKey('binance/perp/klines,1m/B/BTCUSDT/202001/binance|perp|klines,1m|BTCUSDT|20200101.zip')!;

    expect(file).toMatchObject({
      venue: 'binance', market: 'perp', dataset: 'klines', variant: '1m',
      bundle: 'instrument', symbol: 'BTCUSDT', month: '2020-01', date: '20200101',
      grain: 'daily', part: null, container: 'zip',
    });
  });

  /** The date's own length is the grain. */
  it('reads the grain from the length of the date', () => {
    expect(parseKey('x/spot/trades/@/202107/x|spot|trades|@|202107.csv.gz')!.grain).toBe('monthly');
    expect(parseKey('x/spot/books/B/B/202107/x|spot|books|B|2021072603.csv.gz')!.grain).toBe('hourly');
  });

  it('reads a market bundle, a part and a multi-level variant', () => {
    const file = parseKey('gate/spot/books,full,incremental/B/BTC_USDT/202107/gate|spot|books,full,incremental|BTC_USDT|20210726.part03.csv.gz')!;

    expect(file.variant).toBe('full,incremental');
    expect(file.part).toBe('03');
    expect(file.container).toBe('gzip');

    expect(parseKey('okx/perp/funding,realised/@/202607/okx|perp|funding,realised|@|20260729.zip')!.bundle)
      .toBe('market');
  });

  /** A name that is not canonical is not a file of any partition. */
  it('refuses anything that is not a canonical name', () => {
    expect(parseKey('x/spot/trades/B/BTC/202107/x|spot|trades|BTC|20210726.zip.part')).toBeNull();
    expect(parseKey('x/spot/trades/B/BTC/202107/x|spot|trades|BTC|20210726.zip.bak')).toBeNull();
    expect(parseKey('README.md')).toBeNull();
  });
});

describe('partitions', () => {
  const daily = (symbol: string, date: string) =>
    parseKey(`binance/spot/trades,default/B/${symbol}/${date.slice(0, 6)}/binance|spot|trades,default|${symbol}|${date}.zip`)!;

  /** Every instrument's files of a month are one partition. */
  it('puts every instrument of a month in one partition', () => {
    expect(idOf(partitionOf(daily('BTCUSDT', '20200101'))))
      .toBe(idOf(partitionOf(daily('ETHUSDT', '20200131'))));
  });

  /** The same data at another grain or bundle is another partition. */
  it('separates grains and bundles', () => {
    const month = parseKey('binance/spot/trades,default/B/BTCUSDT/202001/binance|spot|trades,default|BTCUSDT|202001.zip')!;
    const bundle = parseKey('binance/spot/trades,default/@/202001/binance|spot|trades,default|@|20200101.zip')!;

    expect(idOf(partitionOf(month))).not.toBe(idOf(partitionOf(daily('BTCUSDT', '20200101'))));
    expect(idOf(partitionOf(bundle))).not.toBe(idOf(partitionOf(daily('BTCUSDT', '20200101'))));
  });

  it('finds the same partition a month either side', () => {
    const key = partitionOf(daily('BTCUSDT', '20201215'));

    expect(neighbourOf(key, 1).month).toBe('2021-01');
    expect(neighbourOf(key, -1).month).toBe('2020-11');
    expect(monthShift('2020-01', -1)).toBe('2019-12');
  });

  it('knows a file in the first or last period of its month', () => {
    expect(edgesOf(daily('A', '20200101'))).toEqual({ first: true, last: false });
    expect(edgesOf(daily('A', '20200229'))).toEqual({ first: false, last: true });
    expect(edgesOf(daily('A', '20200115'))).toEqual({ first: false, last: false });
  });
});
