import { vi } from 'vitest';

process.env.STOCKER_VAULT_DIR = '/tmp/stocker-test-vault';
process.env.STOCKER_ARCHIVES_DIR = '/tmp/stocker-test-archives';
process.env.STOCKER_MIN_FREE_GB = '1';

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
