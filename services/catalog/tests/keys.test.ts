import { describe, expect, it } from 'vitest';
import { _test_partOf as partOf, keyOf } from '../src/listings/keys';

/**
 * A key says what a file is, and where a period is split, which piece. The part
 * is read wherever the pattern says `{PART}`, so it follows the pattern rather
 * than a guess about how names end. Every pattern here is a real one.
 */

describe('which of a period\'s files this is', () => {
  it('reads a numbered piece of a bitget day', () => {
    expect(partOf('trades/UMCBL/BTCUSDT/BTCUSDT_20250219_101.zip',
      'trades/{TRANSFORM:marginToken:UMCBL}/{SYMBOL}/{SYMBOL}_{YYYY}{MM}{DD}_{PART}.zip')).toBe('101');
  });

  it('reads the hour of a gate book', () => {
    expect(partOf('spot/orderbooks/202107/BTC_USDT-2021072603.csv.gz',
      'spot/orderbooks/{YYYY}{MM}/{SYMBOL}-{YYYY}{MM}{DD}{PART}.csv.gz')).toBe('03');
  });

  it('reads a slice with no extension at all', () => {
    expect(partOf('spot_index/202312/slice_index_1702857600', 'spot_index/{YYYY}{MM}/slice_index_{PART}'))
      .toBe('1702857600');
  });

  /** A name that merely ends in digits has no part unless its pattern says so. */
  it('says nothing where the pattern carries no part', () => {
    expect(partOf('spot/candlesticks_1m/202407/BTC_USDT-20240701.csv.gz',
      'spot/candlesticks_1m/{YYYY}{MM}/{SYMBOL}-{YYYY}{MM}{DD}.csv.gz')).toBeUndefined();
  });
});

describe('a key', () => {
  it('puts a part before the extension', () => {
    expect(keyOf('gate/spot/books/B/BTC_USDT/', 'spot/orderbooks/{YYYY}{MM}/{SYMBOL}-{YYYY}{MM}{DD}{PART}.csv.gz',
      { date: '20210726', path: 'spot/orderbooks/202107/BTC_USDT-2021072603.csv.gz' }))
      .toBe('gate/spot/books/B/BTC_USDT/202107/gate|spot|books|BTC_USDT|20210726.part03.csv.gz');
  });

  /** `.` sorts below every digit, so a month's file comes before its days — and its parts after them never arise. */
  it('sorts a month before its days, and a day\'s parts before the next day', () => {
    const name = (date: string, part = '') => keyOf('v/m/d/B/BTC/', `x/{SYMBOL}-{YYYY}{MM}${date.length > 6 ? '{DD}' : ''}${part ? '{PART}' : ''}.gz`,
      { date, path: `x/BTC-${date}${part}.gz` });

    const keys = [name('202001'), name('20200101', '03'), name('20200101', '04'), name('20200102')];

    expect([...keys].sort()).toEqual(keys);
  });
});
