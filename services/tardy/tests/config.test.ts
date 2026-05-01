import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Config calls loadConfig() at import time — each test resets modules and
// re-imports with fresh env vars.

describe('config — loading', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('loads VAULT_URL from env', async () => {
    process.env.VAULT_URL = 'http://vault';

    const { default: config } = await import('../src/config');

    expect(config.vaultUrl).toBe('http://vault');
  }, 15_000);

  it('reads TARDY_SUFFIX and defaults to empty string when absent', async () => {
    process.env.VAULT_URL = 'http://vault';
    delete process.env.TARDY_SUFFIX;

    const { default: config } = await import('../src/config');

    expect(config.suffix).toBe('');
  });

  it('reads TARDY_SUFFIX when set', async () => {
    process.env.VAULT_URL    = 'http://vault';
    process.env.TARDY_SUFFIX = 'tardy';

    const { default: config } = await import('../src/config');

    expect(config.suffix).toBe('tardy');
  });

  it('uses the Tardis BitMEX genesis date (2019-03-30) as the default', async () => {
    process.env.VAULT_URL = 'http://vault';
    delete process.env.TARDY_START_DATE;

    const { default: config } = await import('../src/config');

    expect(config.startDate).toBe('20190330');
  });

  it('parses TARDY_START_DATE in YYYYMMDD format', async () => {
    process.env.VAULT_URL        = 'http://vault';
    process.env.TARDY_START_DATE = '20200101';

    const { default: config } = await import('../src/config');

    expect(config.startDate).toBe('20200101');
  });

  it('parses TARDY_START_DATE in YYYY-MM-DD format', async () => {
    process.env.VAULT_URL        = 'http://vault';
    process.env.TARDY_START_DATE = '2020-01-01';

    const { default: config } = await import('../src/config');

    expect(config.startDate).toBe('20200101');
  });
});

describe('config — validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws when VAULT_URL is missing', async () => {
    delete process.env.VAULT_URL;

    await expect(import('../src/config')).rejects.toThrow('VAULT_URL is required');
  });

  it('throws when TARDY_START_DATE has an invalid format', async () => {
    process.env.VAULT_URL        = 'http://vault';
    process.env.TARDY_START_DATE = 'not-a-date';

    await expect(import('../src/config')).rejects.toThrow('TARDY_START_DATE must be');
  });
});
