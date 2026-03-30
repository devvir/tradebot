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
}));
