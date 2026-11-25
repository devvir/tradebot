import { resolve } from 'node:path';
import { parseEnvFile } from '../env';

/**
 * Load .env.testing from a service's tests directory into process.env, read and expanded as
 * `parseEnvFile` describes. A variable that is already set, even to the empty string, keeps its
 * value. A missing .env.testing loads nothing; any other read error is thrown.
 */
export const loadTestingEnv = (testsDir: string): void => {
  let parsed: Record<string, string>;

  try {
    parsed = parseEnvFile(resolve(testsDir, '.env.testing'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
};
