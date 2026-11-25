import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import config, { _test_loadConfig as loadConfig, _test_parseList as parseList, _test_parsePositiveInt as parsePositiveInt } from '../src/config';

/**
 * What a deployment configures: where the catalog is, which venues, which lens,
 * how many fetches at once, and how much room the volume keeps. Read from env
 * once, at import; each case reads it afresh from the env it sets.
 */
describe('config', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original, CATALOG_API: 'http://catalog.invalid/', CATALOG_TOKEN: 't' };
    delete process.env['HAULER_VENUES'];
    delete process.env['HAULER_LENS'];
    delete process.env['HAULER_CONCURRENCY'];
    delete process.env['HAULER_MIN_FREE_GB'];
  });

  afterEach(() => {
    process.env = original;
  });

  it('is what the environment said when it was imported', () => {
    process.env = original;

    expect(config).toEqual(loadConfig());
  });

  it('defaults to every venue, no lens, a hundred fetches at once and 25 GB kept free', () => {
    expect(loadConfig()).toMatchObject({ venues: [], lens: '', concurrency: 100, minFreeGb: 25, catalogApi: 'http://catalog.invalid' });
  });

  it('reads venues, a lens, a concurrency and the room to keep from env', () => {
    process.env['HAULER_VENUES']      = 'Binance, gate';
    process.env['HAULER_LENS']        = ' backfill-20 ';
    process.env['HAULER_CONCURRENCY'] = '3';
    process.env['HAULER_MIN_FREE_GB'] = '10';

    expect(loadConfig()).toMatchObject({ venues: ['binance', 'gate'], lens: 'backfill-20', concurrency: 3, minFreeGb: 10 });
  });

  it('reads the catalog token without the space around it', () => {
    process.env['CATALOG_TOKEN'] = ' t ';

    expect(loadConfig().catalogToken).toBe('t');
  });

  it('finds the catalog at its address in the module when nothing names one', () => {
    delete process.env['CATALOG_API'];

    expect(loadConfig().catalogApi).toBe('http://catalog:8080');
  });

  it('refuses a concurrency that is not a count', () => {
    process.env['HAULER_CONCURRENCY'] = 'many';

    expect(() => loadConfig()).toThrow(/positive integer/);
  });
});

describe('a count', () => {
  it('is a positive whole number, or the fallback where nothing is given', () => {
    expect(parsePositiveInt('7', 1)).toBe(7);
    expect(parsePositiveInt(undefined, 4)).toBe(4);
    expect(parsePositiveInt('  ', 4)).toBe(4);

    for (const raw of ['0', '-1', '1.5', 'many']) expect(() => parsePositiveInt(raw, 4)).toThrow(/positive integer/);
  });
});

describe('a list', () => {
  it('is its names, trimmed and lower-cased, with the empty ones dropped', () => {
    expect(parseList(' Binance,,GATE , ')).toEqual(['binance', 'gate']);
    expect(parseList(undefined)).toEqual([]);
  });
});
