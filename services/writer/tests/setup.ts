import { vi } from 'vitest';
import { loadTestingEnv } from '@tradebot/utils';

// Load env vars from .env.testing before module initialization
loadTestingEnv(__dirname);

// Mock logger to suppress test output
vi.mock('@devvir/service-kit', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));
