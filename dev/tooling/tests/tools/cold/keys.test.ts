import { describe, expect, it } from 'vitest';
import { idOf, partitionOf } from '../../../src/tools/cold/keys';

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
