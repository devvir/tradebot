import { describe, expect, it } from 'vitest';
import { _test_parseKnown as parseKnown, _test_parseMonth as parseMonth } from '../src/config';

describe('venue and table filters', () => {
  const known = ['binance', 'depthBands', 'trades'];

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
    expect(parseKnown('depthbands,TRADES', 'STOCKER_TABLES', known))
      .toEqual(['depthBands', 'trades']);
  });

  it('treats empty as no filter and de-duplicates the rest', () => {
    expect(parseKnown(undefined, 'STOCKER_VENUES', known)).toEqual([]);
    expect(parseKnown('', 'STOCKER_VENUES', known)).toEqual([]);
    expect(parseKnown('trades,Trades', 'STOCKER_TABLES', known)).toEqual(['trades']);
  });
});

describe('month bounds', () => {
  it('takes YYYY-MM and nothing else', () => {
    expect(parseMonth('2026-06')).toBe('2026-06');
    expect(parseMonth(undefined)).toBeNull();
    expect(() => parseMonth('202606')).toThrow(/YYYY-MM/);
  });
});
