import { describe, expect, it } from 'vitest';
import { gate } from '../src/adapters/gate';

/**
 * Gate's misfiled months.
 *
 * **Every path here was taken from the archive**, not invented: the duplicates it
 * refuses, the truncated and mislabelled months, the one hour that exists nowhere
 * else, and a sample of the 324 klines with no correctly filed twin.
 */

const accepts = (path: string) => gate.accepts!(path);

describe('what gate refuses as misfiled', () => {
  /** 61,884 of 62,208, each with a twin of identical size and ETag. */
  it('refuses a daily file whose directory is the following month', () => {
    expect(accepts('spot/candlesticks_1m/202412/BTC_USDT-20241130.csv.gz')).toBe(false);
    expect(accepts('spot/candlesticks_5m/202407/ETH_USDT-20240630.csv.gz')).toBe(false);
  });

  /** Truncated copies of July 2021, and March 2020 futures under a spot path. */
  it('refuses a monthly file whose directory is another month', () => {
    expect(accepts('spot/deals/202108/ADA_USDT-202107.csv.gz')).toBe(false);
    expect(accepts('spot/deals/202106/BTC_USD-202003.csv.gz')).toBe(false);
    expect(accepts('futures_btc/trades/202106/BTC_USD-202004.csv.gz')).toBe(false);
  });

  it('keeps everything filed under its own month', () => {
    expect(accepts('spot/candlesticks_1m/202411/BTC_USDT-20241130.csv.gz')).toBe(true);
    expect(accepts('spot/deals/202107/ADA_USDT-202107.csv.gz')).toBe(true);
    expect(accepts('futures_btc/trades/202003/BTC_USD-202003.csv.gz')).toBe(true);
  });
});

describe('what survives the rule', () => {
  /**
   * **The hour that exists nowhere else.** Gate wrote 2022-11-30 23:00 into
   * December's directory, and the properly filed November directory stops at hour
   * 22 — so this is the only copy, and its stamp carries the hour that says so.
   */
  it('keeps the 2022 books hour, whose stamp carries an hour', () => {
    expect(accepts('spot/orderbooks/202212/BTC_USDT-2022113023.csv.gz')).toBe(true);
    expect(accepts('futures_usdt/orderbooks/202212/BTC_USDT-2022113023.csv.gz')).toBe(true);
  });

  /** The 324 with no twin — named, because no rule can tell them from the rest. */
  it('keeps a klines file the archive holds nowhere else', () => {
    expect(accepts('spot/candlesticks_1m/202412/FUEL_USDT-20241130.csv.gz')).toBe(true);
    expect(accepts('spot/candlesticks_30s/202412/FUEL_USDT-20241130.csv.gz')).toBe(true);
    expect(accepts('spot/candlesticks_5m/202407/AGIX_USDT-20240630.csv.gz')).toBe(true);
    expect(accepts('spot/candlesticks_1m/202411/SCLP_ETH-20241031.csv.gz')).toBe(true);
  });

  /**
   * **The list is per instrument *and* per day.** A symbol kept on one day is not
   * kept on another, where its file that day has a proper copy.
   */
  it('does not keep a listed instrument on a day it is not listed for', () => {
    expect(accepts('spot/candlesticks_1m/202412/AGIX_USDT-20241130.csv.gz')).toBe(false);
    expect(accepts('spot/candlesticks_1m/202408/FUEL_USDT-20240731.csv.gz')).toBe(true);
    expect(accepts('spot/candlesticks_1m/202410/FUEL_USDT-20240930.csv.gz')).toBe(true);
  });
});

describe('what the rule must not touch', () => {
  it('leaves the snapshot trees alone', () => {
    expect(accepts('spot_index/202312/slice_index_1702857600')).toBe(true);
    expect(accepts('options_ticker/202509/slice_options_ticker_1756691460')).toBe(true);
  });

  /** A delivery contract carries its expiry in the symbol, and two dates in the name. */
  it('leaves a delivery contract alone', () => {
    expect(accepts('delivery_usdt/orderbooks/202305/BTC_USDT_20230512-2023050508.csv.gz'))
      .toBe(true);
  });

  it('still refuses what it refused before', () => {
    expect(accepts('v2/')).toBe(false);
    expect(accepts('spot/201905/')).toBe(false);
  });
});

/**
 * USDT-settled files gate filed under its BTC-settled tree: weekly spot candles
 * named as trades, futures-trade fragments, a few minutes of funding — every
 * path here taken from the archive.
 */
describe('USDT files under the BTC tree', () => {
  it('refuses them, whatever dataset they are filed as', () => {
    expect(accepts('futures_btc/trades/202203/TVK_USDT-202203.csv.gz')).toBe(false);
    expect(accepts('futures_btc/trades/202208/BTC_USDT-202208.csv.gz')).toBe(false);
    expect(accepts('futures_btc/funding_updates/201911/EOS_USDT-201911.csv.gz')).toBe(false);
    expect(accepts('futures_btc/mark_prices/201911/ETH_USDT-201911.csv.gz')).toBe(false);
  });

  it('keeps the BTC tree\'s own instruments, and USDT files where they belong', () => {
    expect(accepts('futures_btc/trades/202203/BTC_USD-202203.csv.gz')).toBe(true);
    expect(accepts('futures_usdt/trades/202208/BTC_USDT-202208.csv.gz')).toBe(true);
    expect(accepts('spot/candlesticks_7d/202203/TVK_USDT-202203.csv.gz')).toBe(true);
  });

  /** A directory is asked about too, and none of them is a file to refuse. */
  it('leaves the directories alone', () => {
    expect(accepts('futures_btc/trades/')).toBe(true);
    expect(accepts('futures_btc/trades/202203/')).toBe(true);
  });
});
