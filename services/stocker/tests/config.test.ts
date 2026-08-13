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

/**
 * The same forms trucker takes, so the two ends of the pipeline are configured
 * the same way — and always returned dashed, which is how partitions are keyed
 * here. What a person types and what the comparison uses need not agree.
 */
describe('month bounds', () => {
  it('takes the three forms and answers in one', () => {
    expect(parseMonth('2026-06', 'X')).toBe('2026-06');
    expect(parseMonth('202606',  'X')).toBe('2026-06');
    expect(parseMonth('2606',    'X')).toBe('2026-06');
    expect(parseMonth(undefined, 'X')).toBeNull();
  });

  it('refuses anything that is not a month', () => {
    expect(() => parseMonth('2026-6',   'X')).toThrow(/yyyy-mm/);
    expect(() => parseMonth('20260601', 'X')).toThrow(/yyyy-mm/);
    expect(() => parseMonth('june',     'X')).toThrow(/yyyy-mm/);
  });

  /** A bound naming month 13 is a typo, and one that would silently match nothing. */
  it('refuses a month outside 01–12', () => {
    expect(() => parseMonth('2026-13', 'STOCKER_END_MONTH')).toThrow(/names month 13/);
    expect(() => parseMonth('202600',  'STOCKER_END_MONTH')).toThrow(/names month 00/);
  });

  /** The variable is named in the error, because two of them exist. */
  it('says which bound was wrong', () => {
    expect(() => parseMonth('nope', 'STOCKER_START_MONTH')).toThrow(/STOCKER_START_MONTH/);
  });
});
