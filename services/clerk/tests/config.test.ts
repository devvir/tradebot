import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('config — loading', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('loads VAULT_URL', async () => {
    process.env.VAULT_URL = 'http://vault';

    const { default: config } = await import('../src/config');

    expect(config.vaultUrl).toBe('http://vault');
  });

  it('throws when VAULT_URL is missing', async () => {
    delete process.env.VAULT_URL;

    await expect(import('../src/config')).rejects.toThrow('VAULT_URL is required');
  });
});
