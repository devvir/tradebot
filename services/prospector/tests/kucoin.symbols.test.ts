import { describe, expect, it } from 'vitest';
import { kucoin } from '../src/adapters/kucoin';
import type { Found } from '../src/types';

/**
 * What kucoin calls an instrument, against how it spells it in a URL.
 *
 * **The API is the authority on the name.** Its archive does not always agree:
 * spot drops the dash outside books, and futures write `BTC` where kucoin trades
 * `XBT`. Neither spelling is wrong — one is a name and the other is a URL — so
 * the row is keyed by the name and the URL is recorded beside it.
 *
 * The two directions are tested against each other, because a divergence
 * between them is silent: a walk files a file under one name and a listing
 * creates a series under the other, and the catalog holds one instrument twice.
 */
const read = (path: string) => {
  const seen = kucoin.inspectUrl!(path);

  if (seen.of !== 'series') throw new Error(`kucoin could not read ${path}`);

  return seen.found;
};

const write = (of: Partial<Found>): string | undefined =>
  kucoin.urlSymbolFor!({ market: 'spot', dataset: 'klines', pattern: 'x', symbol: 'X', ...of });

describe('reading a kucoin path', () => {
  it('keeps the dash a spot book already has', () => {
    const found = read('spot/daily/depth/orderbooklv50/0G-USDT/0G-USDT-orderbooklv50-2025-09-22.zip');

    expect(found).toMatchObject({ symbol: '0G-USDT' });
    expect(found.urlSymbol).toBeUndefined();
  });

  it('puts the dash back for spot klines and trades', () => {
    expect(read('spot/daily/klines/0GUSDT/12h/0GUSDT-12h-2025-09-22.zip'))
      .toMatchObject({ symbol: '0G-USDT', urlSymbol: '0GUSDT' });

    expect(read('spot/daily/trades/BTCUSDT/BTCUSDT-trades-2025-09-22.zip'))
      .toMatchObject({ symbol: 'BTC-USDT', urlSymbol: 'BTCUSDT' });
  });

  /**
   * **A quote kucoin no longer lists cannot be split**, and inventing a dash
   * would be a guess. 23 of the archive's 2,419 dashless names are like this.
   */
  it('leaves a name it cannot split exactly as the path spells it', () => {
    const found = read('spot/daily/klines/NVG8USDTOLD/12h/NVG8USDTOLD-12h-2025-09-22.zip');

    expect(found).toMatchObject({ symbol: 'NVG8USDTOLD' });
    expect(found.urlSymbol).toBeUndefined();
  });

  it('names a futures contract as kucoin trades it, not as the path spells it', () => {
    expect(read('futures/daily/trades/BTCUSDTM/BTCUSDTM-trades-2023-01-01.zip'))
      .toMatchObject({ symbol: 'XBTUSDTM', urlSymbol: 'BTCUSDTM' });

    expect(read('futures/daily/depth/orderbooklv50/BTCMU26/BTCMU26-orderbooklv50-2026-06-17.zip'))
      .toMatchObject({ symbol: 'XBTMU26', urlSymbol: 'BTCMU26' });
  });

  it('leaves a futures contract the archive already spells XBT alone', () => {
    const found = read('futures/daily/trades/XBTMU26/XBTMU26-trades-2026-06-17.zip');

    expect(found).toMatchObject({ symbol: 'XBTMU26' });
    expect(found.urlSymbol).toBeUndefined();
  });
});

describe('spelling a kucoin series created from the listing', () => {
  it('strips the dash for spot klines and trades, and keeps it for books', () => {
    expect(write({ symbol: '0G-USDT', dataset: 'klines' })).toBe('0GUSDT');
    expect(write({ symbol: '0G-USDT', dataset: 'trades' })).toBe('0GUSDT');
    expect(write({ symbol: '0G-USDT', dataset: 'books' })).toBeUndefined();
  });

  /** The three perpetuals are `BTC` in every tree; the dated ones only under books. */
  it('writes BTC for a bitcoin perpetual, whatever the dataset', () => {
    expect(write({ market: 'perp', symbol: 'XBTUSDTM', dataset: 'trades' })).toBe('BTCUSDTM');
    expect(write({ market: 'perp', symbol: 'XBTUSDTM', dataset: 'books' })).toBe('BTCUSDTM');
  });

  it('writes BTC for a dated contract only under books', () => {
    expect(write({ market: 'perp', symbol: 'XBTMU26', dataset: 'books' })).toBe('BTCMU26');
    expect(write({ market: 'perp', symbol: 'XBTMU26', dataset: 'trades' })).toBeUndefined();
  });

  it('says nothing for an instrument the archive spells as kucoin does', () => {
    expect(write({ market: 'perp', symbol: 'ETHUSDTM', dataset: 'trades' })).toBeUndefined();
  });
});

/**
 * **The round trip is the real test.** Reading a path must produce the name and
 * the URL spelling that writing that name back would produce — otherwise a walk
 * and a listing disagree about what one instrument is called.
 */
describe('the two directions agree', () => {
  const paths: [string, string, string][] = [
    ['spot/daily/klines/0GUSDT/12h/0GUSDT-12h-2025-09-22.zip', 'spot', 'klines'],
    ['spot/daily/trades/BTCUSDT/BTCUSDT-trades-2025-09-22.zip', 'spot', 'trades'],
    ['spot/daily/depth/orderbooklv50/0G-USDT/0G-USDT-orderbooklv50-2025-09-22.zip', 'spot', 'books'],
    ['futures/daily/trades/BTCUSDTM/BTCUSDTM-trades-2023-01-01.zip', 'perp', 'trades'],
    ['futures/daily/depth/orderbooklv50/BTCMU26/BTCMU26-orderbooklv50-2026-06-17.zip', 'perp', 'books'],
    ['futures/daily/trades/XBTMU26/XBTMU26-trades-2026-06-17.zip', 'perp', 'trades'],
  ];

  for (const [path, market, dataset] of paths)
    it(`round-trips ${path.split('/').slice(0, 4).join('/')}`, () => {
      const found = read(path);
      const back  = write({ market, dataset, symbol: found.symbol });

      expect(back ?? found.symbol).toBe(found.urlSymbol ?? found.symbol);
    });
});
