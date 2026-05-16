import { vi } from 'vitest';

vi.mock('@devvir/service-kit', async (importOriginal) => {
  const real = await importOriginal<typeof import('@devvir/service-kit')>();

  return {
    ...real,
    logger: {
      info:  vi.fn(),
      warn:  vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
    },
  };
});

/**
 * Safety net: the test suite must NEVER reach a real Redis instance.
 * `dateWalker` is the only Redis-using surface in distiller; we replace it with
 * a thrower so any accidental call (e.g. someone invoking `distillTrades` in a
 * test, or a future refactor pulling the walker into a helper) fails loudly
 * instead of silently connecting to whatever CACHE_URL is in the host env.
 */
vi.mock('../src/utils/dates', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/utils/dates')>();

  return {
    ...real,
    dateWalker: () => {
      throw new Error('dateWalker must not be called in tests — Redis access is blocked');
    },
  };
});
