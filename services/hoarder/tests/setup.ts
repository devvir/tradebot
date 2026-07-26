import { vi } from 'vitest';

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
