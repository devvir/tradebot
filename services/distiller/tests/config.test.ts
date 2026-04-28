import { vi, describe, it, expect } from 'vitest';

vi.hoisted(() => {
  process.env.DB_DATABASE = 'test_config';
});

import { _test_parseGenerators } from '../src/config';

const parseGenerators = _test_parseGenerators;

describe('parseGenerators', () => {
  it('returns null when env var is absent', () => {
    expect(parseGenerators(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseGenerators('')).toBeNull();
  });

  it('returns null for a whitespace-only string', () => {
    expect(parseGenerators('   ')).toBeNull();
  });

  it('parses a single generator', () => {
    expect(parseGenerators('quote')).toEqual(['quote']);
  });

  it('parses multiple generators', () => {
    expect(parseGenerators('quote,trade,orderbook')).toEqual(['quote', 'trade', 'orderbook']);
  });

  it('parses all five generators', () => {
    expect(parseGenerators('quote,trade,orderbook,instrument,partials')).toEqual(
      ['quote', 'trade', 'orderbook', 'instrument', 'partials'],
    );
  });

  it('trims whitespace around names', () => {
    expect(parseGenerators(' quote , trade ')).toEqual(['quote', 'trade']);
  });

  it('throws for an unknown generator name', () => {
    expect(() => parseGenerators('quote,unknown')).toThrow(
      'DISTILLER_GENERATORS: unknown generator "unknown"',
    );
  });

  it('throws listing the valid generator names in the error', () => {
    expect(() => parseGenerators('bogus')).toThrow(
      'Valid: quote, trade, orderbook, instrument, partials',
    );
  });
});
