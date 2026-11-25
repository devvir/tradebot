import { describe, it, expect } from 'vitest';
import { isBitmexDataWithSymbol, isISO8601Timestamp, type BitmexDataItem } from '../src/bitmex';

describe('isISO8601Timestamp', () => {
  it.each([
    '2026-02-15T19:27:38.368Z',
    new Date(0).toISOString(),
    new Date('2026-12-31T23:59:59.999Z').toISOString(),
  ])('accepts %s', value => {
    expect(isISO8601Timestamp(value)).toBe(true);
  });

  it.each([
    ['a 4-digit fraction',  '2026-02-15T19:27:38.3680Z'],
    ['a 2-digit fraction',  '2026-02-15T19:27:38.36Z'],
    ['no fraction',         '2026-02-15T19:27:38Z'],
    ['month 13',            '2026-13-15T19:27:38.368Z'],
    ['hour 24',             '2026-02-15T24:27:38.368Z'],
    ['no Z suffix',         '2026-02-15T19:27:38.368'],
    ['an offset',           '2026-02-15T19:27:38.368+00:00'],
    ['a date only',         '2026-02-15'],
  ])('rejects %s', (_, value) => {
    expect(isISO8601Timestamp(value)).toBe(false);
  });
});

describe('isBitmexDataWithSymbol', () => {
  const withSymbol    = { symbol: 'XBTUSD', timestamp: '2026-02-15T19:27:38.368Z' } as unknown as BitmexDataItem;
  const withoutSymbol = { id: 1, users: 10, bots: 2 } as unknown as BitmexDataItem;

  it('is true when every item carries a symbol', () => {
    expect(isBitmexDataWithSymbol([ withSymbol, withSymbol ])).toBe(true);
  });

  it('is false when only some items carry a symbol', () => {
    expect(isBitmexDataWithSymbol([ withSymbol, withoutSymbol ])).toBe(false);
  });

  it('is false when no item carries a symbol', () => {
    expect(isBitmexDataWithSymbol([ withoutSymbol ])).toBe(false);
  });

  it('is false for an empty array', () => {
    expect(isBitmexDataWithSymbol([])).toBe(false);
  });
});
