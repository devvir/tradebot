import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a deployment configures: where the catalog is, which venues, which lens,
 * and how many fetches at once. Loaded at import, so each test re-imports.
 */
describe('config', () => {
  const original = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...original, CATALOG_URL: 'http://catalog.invalid/', CATALOG_TOKEN: 't' };
    delete process.env['HAULER_VENUES'];
    delete process.env['HAULER_LENS'];
    delete process.env['HAULER_CONCURRENCY'];
  });

  afterEach(() => {
    process.env = original;
  });

  it('defaults to every venue, no lens, and eight fetches at once', async () => {
    const { default: config } = await import('../src/config');

    expect(config).toMatchObject({ venues: [], lens: '', concurrency: 8, catalogUrl: 'http://catalog.invalid' });
  });

  it('reads venues, a lens and a concurrency from env', async () => {
    process.env['HAULER_VENUES']      = 'Binance, gate';
    process.env['HAULER_LENS']        = ' backfill-20 ';
    process.env['HAULER_CONCURRENCY'] = '3';

    const { default: config } = await import('../src/config');

    expect(config).toMatchObject({ venues: ['binance', 'gate'], lens: 'backfill-20', concurrency: 3 });
  });

  it('refuses to start without the catalog, or with a concurrency that is not a count', async () => {
    delete process.env['CATALOG_URL'];

    await expect(import('../src/config')).rejects.toThrow(/CATALOG_URL/);

    vi.resetModules();
    process.env['CATALOG_URL']        = 'http://catalog.invalid';
    process.env['HAULER_CONCURRENCY'] = 'many';

    await expect(import('../src/config')).rejects.toThrow(/positive integer/);
  });
});
