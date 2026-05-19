import { vi } from 'vitest';
import { loadTestingEnv } from '@tradebot/utils';

loadTestingEnv(__dirname);

vi.mock('@devvir/service-kit', () => ({
  logger: {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
  registry: {
    /** Default: a service-shaped stub so calls don't crash. Tests can
     *  override with mockReturnValue when they need specific behaviour. */
    get: vi.fn(() => ({
      emit: vi.fn(),
      on:   vi.fn(),
      off:  vi.fn(),
    })),
  },
}));
