import { describe, expect, it } from 'vitest';
import { extensionOf, intervalOf, partOf } from '../src/catalog/shape';

/**
 * Every pattern here is a real one from the catalog, because these rules exist
 * to be right about the archives that exist rather than about a shape somebody
 * imagined.
 */

describe('the bar length a pattern names', () => {
  it('reads a length that is a whole segment', () => {
    expect(intervalOf('data/futures/um/monthly/klines/{SYMBOL}/12h/{SYMBOL}-12h-{YYYY}-{MM}.zip'))
      .toBe('12h');
    expect(intervalOf('data/klines/swap/daily/{SYMBOL}/15min/{SYMBOL}-15min-{YYYY}-{MM}-{DD}.zip'))
      .toBe('15min');
    expect(intervalOf('historical_data/futures/daily/klines/{SYMBOL}/1d/{SYMBOL}-klines-1d-{YYYY}-{MM}-{DD}.zip'))
      .toBe('1d');
    expect(intervalOf('/data/spot/klines/{SYMBOL}/1mo/{SYMBOL}-1mo-{YYYY}-{MM}.zip')).toBe('1mo');
  });

  it('reads bybit\'s bare minutes out of the filename', () => {
    expect(intervalOf(
      'kline_for_metatrader4/ADAUSDT/{YYYY}/{SYMBOL}_15_{YYYY}-{MM}-01_{YYYY}-{MM}-{MONTH_LAST_DAY}.csv.gz'))
      .toBe('15');
  });

  /**
   * The rule has to stay blind to lengths spelled inside a longer word, or a
   * dataset name and eventually a symbol would start looking like one.
   */
  it('says nothing where the length is part of the dataset name', () => {
    expect(intervalOf('spot/candlesticks_5m/{YYYY}{MM}/{SYMBOL}-{YYYY}{MM}.csv.gz')).toBeUndefined();
    expect(intervalOf('futures_btc/candlesticks_10s/{YYYY}{MM}/{SYMBOL}-{YYYY}{MM}.csv.gz'))
      .toBeUndefined();
  });

  it('says nothing for the venues that name no length anywhere', () => {
    expect(intervalOf('kline/{SYMBOL}/UMCBL/{YYYY}{MM}{DD}.zip')).toBeUndefined();
    expect(intervalOf('okex/traderecords/candlesticks/monthly/{YYYY}{MM}/{SYMBOL}-candlesticks-{YYYY}-{MM}.zip'))
      .toBeUndefined();
  });

  it('is not fooled by a depth, a date or a level that merely looks like one', () => {
    expect(intervalOf('okx/match/orderbook/L2/400lv/daily/{YYYY}{MM}{DD}/{SYMBOL}-L2orderbook-400lv-{YYYY}-{MM}-{DD}.tar.gz'))
      .toBeUndefined();
    expect(intervalOf('spot/orderbooks/{YYYY}{MM}/{SYMBOL}-{YYYY}{MM}{DD}{HH}.csv.gz')).toBeUndefined();
  });
});

describe('a file\'s extension', () => {
  /** Two- and three-part extensions are one extension, so the first dot wins. */
  it('takes everything from the first dot of the name', () => {
    expect(extensionOf('spot/deals/202106/BTC_USDT-202106.csv.gz')).toBe('.csv.gz');
    expect(extensionOf('orderbook/linear/0GUSDT/2025-09-18_0GUSDT_ob200.data.zip')).toBe('.data.zip');
    expect(extensionOf('a/b/BTC-USDT-L2orderbook-400lv-2023-09-18.tar.gz')).toBe('.tar.gz');
    expect(extensionOf('kline/ENJUSDT/UMCBL/20221006.zip')).toBe('.zip');
  });

  it('is empty where a venue publishes no extension at all', () => {
    expect(extensionOf('spot_index/202312/slice_index_1702857600')).toBe('');
  });

  it('is not confused by dots in a directory above the file', () => {
    expect(extensionOf('a.b/c/plain')).toBe('');
  });
});

describe('which of a period\'s files this is', () => {
  const BITGET = 'trades/UMCBL/{SYMBOL}/{YYYY}{MM}{DD}_001.zip';

  it('reads the part where the pattern says the venue splits a period', () => {
    expect(partOf('trades/UMCBL/BTCUSDT/20250219_001.zip', BITGET)).toBe('001');
    expect(partOf('trades/UMCBL/BTCUSDT/20250219_101.zip', BITGET)).toBe('101');
  });

  /**
   * The pattern has to agree, or every venue whose filenames happen to end in
   * three digits would sprout a part it does not have.
   */
  it('says nothing where the pattern carries no part', () => {
    expect(partOf('a/b/BTCUSDT-2025-02-19_100.zip', 'a/b/{SYMBOL}-{YYYY}-{MM}-{DD}_100.zip'))
      .toBe('100');
    expect(partOf('a/b/something_123.zip', 'a/b/{SYMBOL}-{YYYY}{MM}{DD}.zip')).toBeUndefined();
    expect(partOf('spot/candlesticks_1m/202407/BTC_USDT-20240701.csv.gz',
      'spot/candlesticks_1m/{YYYY}{MM}/{SYMBOL}-{YYYY}{MM}{DD}.csv.gz')).toBeUndefined();
  });
});
