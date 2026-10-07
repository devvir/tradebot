import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@devvir/service-kit';
import { extensionOf, intervalOf } from '../src/listings/shape';

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
  it('is the last extension', () => {
    expect(extensionOf('kline/ENJUSDT/UMCBL/20221006.zip')).toBe('.zip');
    expect(extensionOf('kline/ENJUSDT/UMCBL/20221006.ZIP')).toBe('.zip');
    expect(extensionOf('kline/ENJUSDT/UMCBL/20221006.7z')).toBe('.7z');
  });

  /** A compressed stream names nothing inside it, so what it holds is part of how it is wrapped. */
  it('keeps what a compressed stream is', () => {
    expect(extensionOf('spot/deals/202106/BTC_USDT-202106.csv.gz')).toBe('.csv.gz');
    expect(extensionOf('a/b/BTC-USDT-L2orderbook-400lv-2023-09-18.tar.gz')).toBe('.tar.gz');
    expect(extensionOf('tradfi/candlesticks_1h/202605/BRK.B-202605.csv.gz')).toBe('.csv.gz');
  });

  /** An archive names its own members: what a venue writes before `.zip` is its styling, not the file's kind. */
  it('drops what a venue styles in front of an archive\'s extension', () => {
    expect(extensionOf('orderbook/linear/0GUSDT/2025-09-18_0GUSDT_ob200.data.zip')).toBe('.zip');
    expect(extensionOf('trade/option/BTC/2024-12-16_BTC_USDT.trades.csv.zip')).toBe('.zip');
    expect(extensionOf('mark_kline/option/BTC/2024-12-16_BTC_USDT.OHLC.csv.zip')).toBe('.zip');
  });

  /** What gate names wrongly, or not at all, is named for what it holds. */
  it('gives the files known to be misnamed the ending they should have', () => {
    expect(extensionOf('spot/orderbooks_slice/202108/BTC_USDT-2021080100.gz')).toBe('.json.gz');
    expect(extensionOf('futures_btc/orderbooks_slice/202610/BTC_USD-2026100100.gz')).toBe('.json.gz');
    expect(extensionOf('spot_index/202312/slice_index_1702857600')).toBe('.txt');
    expect(extensionOf('options_ticker/202509/slice_options_ticker_1756691880')).toBe('.txt');
  });

  describe('where a file\'s own ending says nothing usable', () => {
    const warned = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    beforeEach(() => warned.mockClear());

    /** Never a bare compressor: a stream that does not say what it is, is text. */
    it('takes a compressed stream for text, and says so', () => {
      expect(extensionOf('x/something.gz')).toBe('.txt.gz');
      expect(extensionOf('x/BRK.B-202605.gz')).toBe('.txt.gz');
      expect(extensionOf('x/BTC_USDT-2021.08.gz')).toBe('.txt.gz');
      expect(warned).toHaveBeenCalledTimes(3);
    });

    it('takes a file with no extension for text, and says so', () => {
      expect(extensionOf('x/plain')).toBe('.txt');
      expect(extensionOf('a.b/c/plain')).toBe('.txt');
      expect(extensionOf('x/BTC_USDT-2021.08')).toBe('.txt');
      expect(warned).toHaveBeenCalledTimes(3);
    });

    it('says nothing of a file it names by a rule', () => {
      extensionOf('spot/deals/202106/BTC_USDT-202106.csv.gz');
      extensionOf('spot_index/202312/slice_index_1702857600');
      expect(warned).not.toHaveBeenCalled();
    });
  });
});
