import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The config is read once, when the module loads, so each case loads a fresh
// copy under its own environment.

const load = async (level: string | undefined): Promise<number> => {
  if (level === undefined) delete process.env.VAULT_COMPRESSION_LEVEL;
  else process.env.VAULT_COMPRESSION_LEVEL = level;

  vi.resetModules();

  return (await import('../src/config')).default.compressionLevel;
};

const saved = process.env.VAULT_COMPRESSION_LEVEL;

beforeEach(() => { delete process.env.VAULT_COMPRESSION_LEVEL; });

afterEach(() => {
  if (saved === undefined) delete process.env.VAULT_COMPRESSION_LEVEL;
  else process.env.VAULT_COMPRESSION_LEVEL = saved;
});

describe('VAULT_COMPRESSION_LEVEL', () => {
  it('defaults to 6 when unset', async () => {
    expect(await load(undefined)).toBe(6);
  });

  it.each(['1', '9'])('accepts %s', async (level) => {
    expect(await load(level)).toBe(Number(level));
  });

  it.each(['0', '10', '1.5', 'abc'])('refuses %s', async (level) => {
    await expect(load(level)).rejects.toThrow(/VAULT_COMPRESSION_LEVEL must be an integer between 1 and 9/);
  });
});
