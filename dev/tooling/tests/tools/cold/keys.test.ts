import { describe, expect, it } from 'vitest';
import { idOf, partitionOf } from '../../../src/tools/cold/shared/keys';

/** A file's name says which partition it belongs to, and nothing else is read. */
describe('the partition a file belongs to', () => {
  it('reads venue, market, dataset, variant, bundle, grain and month off the name', () => {
    expect(partitionOf('gate/perp/klines,1m/B/BTC_USDT/202006/gate|perp|klines,1m|BTC_USDT|20200615.csv.gz')).toEqual({
      venue: 'gate', market: 'perp', dataset: 'klines', variant: '1m',
      grain: 'daily', bundle: 'instrument', month: '202006',
    });
  });

  it('takes the grain from the length of the date', () => {
    const grainOf = (date: string) => partitionOf(`x|spot|trades|A|${date}.zip`)?.grain;

    expect([grainOf('202006'), grainOf('20200615'), grainOf('2020061507'), grainOf('202006150730')])
      .toEqual(['monthly', 'daily', 'hourly', 'minutely']);
  });

  it('reads a venue-wide file as the market bundle', () => {
    expect(partitionOf('okx|spot|trades|@|20200615.zip')).toMatchObject({ bundle: 'market', variant: '' });
  });

  it('keeps a split period in its own month', () => {
    expect(partitionOf('bitget|spot|trades|BTCUSDT|20200615.part001.zip')).toMatchObject({ month: '202006', grain: 'daily' });
  });

  /** No ending is listed: one extension, or a compressed stream's two, whatever the venue. */
  it('reads a name whatever its ending', () => {
    for (const tail of ['20241216.zip', '202101.part3.csv.gz', '20230927.tar.gz', '20210825.part03.json.gz', '202312.part1702857600.txt', '20241216.7z'])
      expect(partitionOf(`bybit|option|trades|BTC|${tail}`), tail).not.toBeNull();

    expect(partitionOf('bybit|option|trades|BTC|20241216.zip')).toMatchObject({ month: '202412', grain: 'daily' });
  });

  it('does not take a file set aside, or one still arriving, for a file of the partition', () => {
    expect(partitionOf('okx|perp|trades|A-USDT|202511.zip.bak')).toBeNull();
    expect(partitionOf('okx|perp|trades|A-USDT|202511.zip.part')).toBeNull();
    expect(partitionOf('gate|spot|books|BTC_USDT|20210726.csv.gz.bak')).toBeNull();
    expect(partitionOf('gate|spot|indexPrice,ticks|@|202312.part1702857600.txt.bak')).toBeNull();
    expect(partitionOf('gate|spot|indexPrice,ticks|@|202312.part1702857600')).toBeNull();
  });

  it('is nothing for a name that is not a canonical file', () => {
    expect(partitionOf('gate/perp/trades/B/BTC_USDT/202006/notes.txt')).toBeNull();
    expect(partitionOf('gate|perp|trades|BTC_USDT|june.csv.gz')).toBeNull();
  });

  /** The same data at another grain or in another bundle is another partition. */
  it('tells partitions apart by grain and by bundle', () => {
    const daily   = partitionOf('x|spot|trades|A|20200615.zip')!;
    const monthly = partitionOf('x|spot|trades|A|202006.zip')!;
    const bucket  = partitionOf('x|spot|trades|@|20200615.zip')!;

    expect(new Set([idOf(daily), idOf(monthly), idOf(bucket)]).size).toBe(3);
  });
});
