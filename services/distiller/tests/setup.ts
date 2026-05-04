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
