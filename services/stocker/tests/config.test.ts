import { describe, expect, it } from 'vitest';
import { _test_parseKnown as parseKnown } from '../src/config';

describe('the venue filter', () => {
  const known = ['binance', 'orderBookBands', 'trades'];

  /**
   * These vocabularies are closed — every venue and table stocker will ever see
   * is declared in the series map — so a token outside them can never match,
   * and accepting one turns a typo into an eternally clean run of zero
   * partitions.
   */
  it('rejects a token outside the vocabulary, naming the valid ones', () => {
    expect(() => parseKnown('binance,krakken', 'STOCKER_VENUES', known))
      .toThrow(/krakken.*Valid: binance/s);
  });

  it('accepts any case and returns the canonical spelling', () => {
    expect(parseKnown('BINANCE', 'STOCKER_VENUES', known)).toEqual(['binance']);
    expect(parseKnown('orderbookbands,TRADES', 'STOCKER_VENUES', known))
      .toEqual(['orderBookBands', 'trades']);
  });

  it('treats empty as no filter and de-duplicates the rest', () => {
    expect(parseKnown(undefined, 'STOCKER_VENUES', known)).toEqual([]);
    expect(parseKnown('', 'STOCKER_VENUES', known)).toEqual([]);
    expect(parseKnown('trades,Trades', 'STOCKER_VENUES', known)).toEqual(['trades']);
  });
});
