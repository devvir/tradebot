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

  it('uses default prefetch and flushIntervalMs', async () => {
    const { default: config } = await import('../src/config');

    expect(config.prefetch).toBe(500);
    expect(config.flushIntervalMs).toBe(50);
  });

  it('respects REGISTRAR_PREFETCH override', async () => {
    process.env.REGISTRAR_PREFETCH = '100';

    const { default: config } = await import('../src/config');

    expect(config.prefetch).toBe(100);
  });

  it('respects REGISTRAR_FLUSH_INTERVAL_MS override', async () => {
    process.env.REGISTRAR_FLUSH_INTERVAL_MS = '250';

    const { default: config } = await import('../src/config');

    expect(config.flushIntervalMs).toBe(250);
  });
});
