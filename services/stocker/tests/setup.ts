import { rmSync } from 'node:fs';
import { afterAll, vi } from 'vitest';

/**
 * A vault and archives of its own for each worker: test files run side by
 * side, and one clearing its vault must not take another's scratch with it.
 */
const worker = process.env.VITEST_POOL_ID ?? '0';

process.env.DATA_VAULT_DIR = `/tmp/stocker-test-vault-${worker}`;
process.env.DATA_ARCHIVES_DIR = `/tmp/stocker-test-archives-${worker}`;
process.env.STOCKER_MIN_FREE_GB = '1';

afterAll(() => {
  rmSync(process.env.DATA_VAULT_DIR!, { recursive: true, force: true });
  rmSync(process.env.DATA_ARCHIVES_DIR!, { recursive: true, force: true });
});

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
