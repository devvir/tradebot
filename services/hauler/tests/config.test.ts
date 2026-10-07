import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a deployment configures: where the catalog is, which venues, which lens,
 * and how many fetches at once. Loaded at import, so each test re-imports — and
 * the first import loads the service kit cold, which alone can outlast the
 * default five seconds while other suites run beside it.
 */
describe('config', { timeout: 30_000 }, () => {
  const original = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...original, CATALOG_API: 'http://catalog.invalid/', CATALOG_TOKEN: 't' };
    delete process.env['HAULER_VENUES'];
    delete process.env['HAULER_LENS'];
    delete process.env['HAULER_CONCURRENCY'];
    delete process.env['HAULER_MIN_FREE_GB'];
  });

  afterEach(() => {
    process.env = original;
  });

  it('defaults to every venue, no lens, and a hundred fetches at once', async () => {
    const { default: config } = await import('../src/config');

    expect(config).toMatchObject({ venues: [], lens: '', concurrency: 100, minFreeGb: 25, catalogApi: 'http://catalog.invalid' });
  });

  it('reads venues, a lens and a concurrency from env', async () => {
    process.env['HAULER_VENUES']      = 'Binance, gate';
    process.env['HAULER_LENS']        = ' backfill-20 ';
    process.env['HAULER_CONCURRENCY'] = '3';

    const { default: config } = await import('../src/config');

    expect(config).toMatchObject({ venues: ['binance', 'gate'], lens: 'backfill-20', concurrency: 3 });
  });

  it('finds the catalog at its address in the module when nothing names one', async () => {
    delete process.env['CATALOG_API'];

    const { default: config } = await import('../src/config');

    expect(config.catalogApi).toBe('http://catalog:8080');
  });

  it('refuses a concurrency that is not a count', async () => {
    process.env['HAULER_CONCURRENCY'] = 'many';

    await expect(import('../src/config')).rejects.toThrow(/positive integer/);
  });
});
