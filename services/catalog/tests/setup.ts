import { vi } from 'vitest';
import config from '../src/config';

/** Only the logger is stubbed: the tests have nothing to say to a terminal. */
vi.mock('@devvir/service-kit', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
}));

/** A call to prospector is tried again at once: what is tried, and how often, is what the tests look at. */
config.retryMs = 1;
