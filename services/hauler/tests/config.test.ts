import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _test_parseCanonical, _test_parseMonth } from '../src/config';

// Config module calls loadConfig() at import time, so each test that checks
// what actually gets loaded must reset the module registry and re-import with
// fresh env vars. The pure parsers below need none of that.

describe('config — loading', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, CATALOG_URL: 'http://catalog.invalid', CATALOG_TOKEN: 't' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('defaults markets, datasets and the span to unconstrained', async () => {
    delete process.env.HAULER_MARKETS;
    delete process.env.HAULER_DATASETS;
    delete process.env.HAULER_FROM;
    delete process.env.HAULER_TO;

    const { default: config } = await import('../src/config');

    expect(config.markets).toEqual([]);
    expect(config.datasets).toEqual([]);
    expect(config.from).toBeUndefined();
    expect(config.to).toBeUndefined();
  });

  it('loads markets, datasets and a span from env', async () => {
    process.env.HAULER_MARKETS  = 'perp, spot';
    process.env.HAULER_DATASETS = 'klines';
    process.env.HAULER_FROM     = '202101';
    process.env.HAULER_TO       = '202312';

    const { default: config } = await import('../src/config');

    expect(config.markets).toEqual(['perp', 'spot']);
    expect(config.datasets).toEqual(['klines']);
    expect(config.from).toBe('202101');
    expect(config.to).toBe('202312');
  });
});

describe('config — validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, CATALOG_URL: 'http://catalog.invalid', CATALOG_TOKEN: 't' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('rejects a market outside the vocabulary', async () => {
    process.env.HAULER_MARKETS = 'perp,futures_usdt';

    await expect(import('../src/config')).rejects.toThrow(/HAULER_MARKETS/);
  });

  it('rejects a dataset outside the vocabulary', async () => {
    process.env.HAULER_DATASETS = 'candlesticks_1m';

    await expect(import('../src/config')).rejects.toThrow(/HAULER_DATASETS/);
  });

  it('rejects a malformed month', async () => {
    process.env.HAULER_FROM = '2021-01';

    await expect(import('../src/config')).rejects.toThrow(/HAULER_FROM must be a yyyymm month/);
  });
});

describe('parseCanonical', () => {
  it('lowercases, trims and drops blanks', () => {
    expect(_test_parseCanonical('X', ' Perp , spot ,,', ['perp', 'spot']))
      .toEqual(['perp', 'spot']);
  });

  it('empty or absent means unconstrained', () => {
    expect(_test_parseCanonical('X', undefined, ['perp'])).toEqual([]);
    expect(_test_parseCanonical('X', '', ['perp'])).toEqual([]);
  });

  it('throws naming the value and the vocabulary', () => {
    expect(() => _test_parseCanonical('HAULER_MARKETS', 'perp,bogus', ['perp', 'spot']))
      .toThrow('bogus');
  });
});

describe('parseMonth', () => {
  it('accepts a yyyymm month', () => {
    expect(_test_parseMonth('X', '202101')).toBe('202101');
  });

  it('absent or blank means unconstrained', () => {
    expect(_test_parseMonth('X', undefined)).toBeUndefined();
    expect(_test_parseMonth('X', '  ')).toBeUndefined();
  });

  it('throws on anything else', () => {
    expect(() => _test_parseMonth('HAULER_FROM', '2021')).toThrow('HAULER_FROM');
    expect(() => _test_parseMonth('HAULER_FROM', '2021-01')).toThrow('HAULER_FROM');
  });
});
