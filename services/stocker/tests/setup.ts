import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, vi } from 'vitest';

/**
 * A vault and archives of its own for each test file: files run side by side,
 * and so may whole runs on one host, and one clearing its vault must not take
 * another's scratch with it.
 *
 * Named here and made by the tests that use it, so a file whose tests are all
 * skipped — and whose `afterAll` never runs — leaves nothing behind.
 */
const worker = process.env.VITEST_POOL_ID ?? '0';
const root   = join(tmpdir(), `stocker-test-${process.pid}-${worker}-${randomUUID()}`);

process.env.DATA_VAULT_DIR = join(root, 'vault');
process.env.DATA_ARCHIVES_DIR = join(root, 'archives');
process.env.STOCKER_MIN_FREE_GB = '1';

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
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
