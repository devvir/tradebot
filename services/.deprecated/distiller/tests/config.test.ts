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
    expect(parseDistillers('orderbook')).toEqual(['orderbook']);
  });

  it('parses multiple distillers', () => {
    expect(parseDistillers('orderbook,instrument')).toEqual(['orderbook', 'instrument']);
  });

  it('parses every distiller name', () => {
    expect(parseDistillers('orderbook,instrument,partials')).toEqual(
      ['orderbook', 'instrument', 'partials'],
    );
  });

  it('trims whitespace around names', () => {
    expect(parseDistillers(' orderbook , instrument ')).toEqual(['orderbook', 'instrument']);
  });

  it('throws for an unknown distiller name', () => {
    expect(() => parseDistillers('orderbook,unknown')).toThrow(
      'DISTILLER_DISTILLERS: unknown distiller "unknown"',
    );
  });

  it('throws listing the valid distiller names in the error', () => {
    expect(() => parseDistillers('bogus')).toThrow(
      'Valid: orderbook, instrument, partials',
    );
  });
});
