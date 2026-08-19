import { describe, expect, it } from 'vitest';
import { canonicalInterval, variantOf } from '../src/canonical';

/**
 * One spelling per duration, so that asking for hourly bars never means knowing
 * which venue published them.
 */
describe('canonicalInterval', () => {
  it('keeps what is already canonical', () => {
    for (const token of ['1s', '1m', '5m', '15m', '30m', '1h', '4h', '12h', '1d', '3d', '1w'])
      expect(canonicalInterval(token)).toBe(token);
  });

  it('reads every spelling the venues use', () => {
    expect(canonicalInterval('1min')).toBe('1m');
    expect(canonicalInterval('15min')).toBe('15m');
    expect(canonicalInterval('60min')).toBe('1h');
    expect(canonicalInterval('4hour')).toBe('4h');
    expect(canonicalInterval('1day')).toBe('1d');
  });

  it('promotes a duration to the largest whole unit that fits', () => {
    expect(canonicalInterval('7d')).toBe('1w');
    expect(canonicalInterval('24h')).toBe('1d');
    expect(canonicalInterval('120m')).toBe('2h');
    expect(canonicalInterval('60s')).toBe('1m');
  });

  it('stays in the finer unit where the coarser one does not divide it', () => {
    expect(canonicalInterval('90m')).toBe('90m');
    expect(canonicalInterval('30s')).toBe('30s');
    expect(canonicalInterval('10s')).toBe('10s');
  });

  /** Bybit's MetaTrader feed, and nothing else, names a bar by bare minutes. */
  it('reads a bare number as minutes', () => {
    expect(canonicalInterval('1')).toBe('1m');
    expect(canonicalInterval('60')).toBe('1h');
  });

  it('keeps a calendar month out of the arithmetic', () => {
    expect(canonicalInterval('1mo')).toBe('1mo');
    expect(canonicalInterval('1month')).toBe('1mo');
    expect(canonicalInterval('mo')).toBe('1mo');
  });

  /** A caller's cue that it has matched something that is not an interval. */
  it('refuses a token that names no duration', () => {
    for (const token of ['', 'daily', 'lv400', '1x', 'm1'])
      expect(canonicalInterval(token)).toBeNull();
  });
});

describe('variantOf', () => {
  it('joins the levels a dataset carries, in order', () => {
    expect(variantOf('500', 'incremental')).toBe('500,incremental');
    expect(variantOf('1m')).toBe('1m');
  });

  it('is empty for a dataset that carries none', () => {
    expect(variantOf()).toBe('');
    expect(variantOf(undefined, null)).toBe('');
  });
});
