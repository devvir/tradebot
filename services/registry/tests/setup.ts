import { vi } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// Override DB_URL with the actual port discovered by global-setup.
// loadTestingEnv would not override an already-set DB_URL, so we do it directly.
try {
  const { mongoPort } = JSON.parse(readFileSync(resolve(__dirname, '.ports.json'), 'utf8')) as { mongoPort: number };
  process.env['DB_URL'] = `mongodb://root:root@localhost:${mongoPort}/?authSource=admin`;
} catch {
  // .ports.json not present — tests will fail naturally if DB_URL is wrong
}

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
