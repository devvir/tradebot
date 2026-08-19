import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

/**
 * Only the logger is stubbed. `guardBody` is the real one — it wraps every
 * response this service reads, so a stub would quietly take the body guard out
 * of every test that thinks it is exercising a request.
 *
 * **Taken from the module that defines it rather than from the package root.**
 * The root pulls in the servers as a side effect — express, ws — into every test
 * worker, for one function, which cost more than every test in the file it was
 * slowing down.
 */
vi.mock('@devvir/service-kit', async () => ({
  guardBody: (await vi.importActual<Record<string, unknown>>(
    '../../packages/service-kit/src/net/clients/fetch')).guardBody,
  logger: {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));
