import { vi } from 'vitest';

process.env.STOCKER_VAULT_DIR = '/tmp/stocker-test-vault';
process.env.TRUCKER_DATA_DIR = '/tmp/stocker-test-raw';

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
