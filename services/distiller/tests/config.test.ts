import { vi, describe, it, expect } from 'vitest';

vi.hoisted(() => {
  process.env.DB_DATABASE = 'test_config';
});

import { _test_parseDistillers } from '../src/config';

const parseDistillers = _test_parseDistillers;

describe('parseDistillers', () => {
  it('returns null when env var is absent', () => {
    expect(parseDistillers(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseDistillers('')).toBeNull();
  });

  it('returns null for a whitespace-only string', () => {
    expect(parseDistillers('   ')).toBeNull();
  });

  it('parses a single distiller', () => {
    expect(parseDistillers('quote')).toEqual(['quote']);
  });

  it('parses multiple distillers', () => {
    expect(parseDistillers('quote,trade,orderbook')).toEqual(['quote', 'trade', 'orderbook']);
  });

  it('parses all five distillers', () => {
    expect(parseDistillers('quote,trade,orderbook,instrument,partials')).toEqual(
      ['quote', 'trade', 'orderbook', 'instrument', 'partials'],
    );
  });

  it('trims whitespace around names', () => {
    expect(parseDistillers(' quote , trade ')).toEqual(['quote', 'trade']);
  });

  it('throws for an unknown distiller name', () => {
    expect(() => parseDistillers('quote,unknown')).toThrow(
      'DISTILLER_DISTILLERS: unknown distiller "unknown"',
    );
  });

  it('throws listing the valid distiller names in the error', () => {
    expect(() => parseDistillers('bogus')).toThrow(
      'Valid: quote, trade, orderbook, instrument, partials',
    );
  });
});
