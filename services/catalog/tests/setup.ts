import { vi } from 'vitest';

/** Only the logger is stubbed: the tests have nothing to say to a terminal. */
vi.mock('@devvir/service-kit', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
}));
