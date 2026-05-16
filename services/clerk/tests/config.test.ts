import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('config — loading', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, QUEUE_URL: 'amqp://q', VAULT_URL: 'http://vault' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('loads QUEUE_URL', async () => {
    const { default: config } = await import('../src/config');

    expect(config.queueUrl).toBe('amqp://q');
  });

  it('loads VAULT_URL', async () => {
    const { default: config } = await import('../src/config');

    expect(config.vaultUrl).toBe('http://vault');
  });

  it('throws when QUEUE_URL is missing', async () => {
    delete process.env.QUEUE_URL;

    await expect(import('../src/config')).rejects.toThrow('QUEUE_URL is required');
  });

  it('throws when VAULT_URL is missing', async () => {
    delete process.env.VAULT_URL;

    await expect(import('../src/config')).rejects.toThrow('VAULT_URL is required');
  });
});
