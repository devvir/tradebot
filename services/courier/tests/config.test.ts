import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Config module calls loadConfig() at import time, so each test must reset
// the module registry and re-import with fresh env vars.

describe('config — loading', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('loads valid config from env vars', async () => {
    process.env.VAULT_URL = 'http://vault';

    const { default: config } = await import('../src/config');

    expect(config.vaultUrl).toBe('http://vault');
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
});
