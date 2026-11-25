import { afterEach, describe, expect, it, vi } from 'vitest';

/** The configuration as loaded under the given environment. */
const loadedWith = async (env: Record<string, string | undefined>) => {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.resetModules();

  return (await import('../src/config')).default;
};

afterEach(() => { vi.unstubAllEnvs(); });

describe('prospectorApi', () => {
  it('answers at prospector inside the module network by default', async () => {
    expect((await loadedWith({ PROSPECTOR_API: undefined })).prospectorApi).toBe('http://prospector:8080');
  });

  it('is whatever PROSPECTOR_API names', async () => {
    expect((await loadedWith({ PROSPECTOR_API: 'http://localhost:9090' })).prospectorApi).toBe('http://localhost:9090');
  });

  it('drops a trailing slash', async () => {
    expect((await loadedWith({ PROSPECTOR_API: 'http://localhost:9090/' })).prospectorApi).toBe('http://localhost:9090');
  });

  it('falls back to the default when PROSPECTOR_API is blank', async () => {
    expect((await loadedWith({ PROSPECTOR_API: '   ' })).prospectorApi).toBe('http://prospector:8080');
  });
});
