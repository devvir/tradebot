import { describe, expect, it } from 'vitest';
import {
  _test_parseMonth as parseMonth,
  _test_parseList as parseList,
  _test_parseVenues as parseVenues,
} from '../src/config';
import { endOfMonth } from '../src/dates';

describe('TRUCKER_VENUES', () => {
  it('defaults to every known venue and deduplicates explicit lists', () => {
    expect(parseVenues(undefined).length).toBeGreaterThanOrEqual(7);
    expect(parseVenues('okx, okx, binance')).toEqual(['okx', 'binance']);
  });

  it('rejects an unknown venue by name', () => {
    expect(() => parseVenues('mexc')).toThrow(/unknown venue "mexc"/);
  });
});

describe('TRUCKER_SYMBOLS', () => {
  it('uppercases tokens and drops blanks', () => {
    expect(parseList(' btc, ,eth ')).toEqual(['BTC', 'ETH']);
    expect(parseList(undefined)).toEqual([]);
  });
});

describe('month bounds', () => {
  it('accepts all three forms and normalises them', () => {
    expect(parseMonth('2026-07', 'X')).toBe('202607');
    expect(parseMonth('202607', 'X')).toBe('202607');
    expect(parseMonth('2607', 'X')).toBe('202607');   // short year
    expect(parseMonth(undefined, 'X')).toBeNull();
    expect(parseMonth('  ', 'X')).toBeNull();
  });

  it('rejects a date, which is the ambiguity this replaced', () => {
    expect(() => parseMonth('2026-07-15', 'TRUCKER_END_MONTH'))
      .toThrow(/TRUCKER_END_MONTH/);
  });

  it('rejects a month that is not a month, naming the variable', () => {
    expect(() => parseMonth('2026-13', 'TRUCKER_START_MONTH')).toThrow(/TRUCKER_START_MONTH/);
    expect(() => parseMonth('2026-00', 'TRUCKER_START_MONTH')).toThrow(/TRUCKER_START_MONTH/);
    expect(() => parseMonth('July', 'TRUCKER_END_MONTH')).toThrow(/TRUCKER_END_MONTH/);
  });
});

describe('the ceiling a month bound implies', () => {
  /** Inclusive: naming a month fetches through its final day. */
  it('runs to the last day of the month named', () => {
    expect(endOfMonth('202607')).toBe('20260731');
    expect(endOfMonth('202602')).toBe('20260228');
    expect(endOfMonth('202002')).toBe('20200229');   // leap year
  });

  it('is unbounded when no ceiling is configured', () => {
    // Nothing downstream can use a half-collected month, so waiting for one to
    // close only moved the work into a spike on the first of the next month.
    expect(parseMonth(undefined, 'TRUCKER_END_MONTH')).toBeNull();
  });
});
