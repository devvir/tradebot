import { vi } from 'vitest';

process.env.TRUCKER_DIR = '/tmp/trucker-test';

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
