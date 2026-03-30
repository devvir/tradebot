import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Config module calls loadConfig() at import time, so each test resets the
// module registry and re-imports with fresh env vars.

describe('config — loading', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('loads QUEUE_URL and default prefetch', async () => {
    process.env.QUEUE_URL = 'amqp://guest:guest@rabbitmq:5672';

    const { default: config } = await import('../src/config');

    expect(config.queueUrl).toBe('amqp://guest:guest@rabbitmq:5672');
    expect(config.prefetch).toBe(200);
  });

  it('respects ASSEMBLER_PREFETCH override', async () => {
    process.env.QUEUE_URL         = 'amqp://rabbitmq:5672';
    process.env.ASSEMBLER_PREFETCH = '50';

    const { default: config } = await import('../src/config');

    expect(config.prefetch).toBe(50);
  });

  it('throws when QUEUE_URL is missing', async () => {
    delete process.env.QUEUE_URL;

    await expect(import('../src/config')).rejects.toThrow('QUEUE_URL is required');
  });
});
