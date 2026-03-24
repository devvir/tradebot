import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Parse a .env file and return the key-value pairs.
 *
 * Supports:
 *  - `# comments` and blank lines (skipped)
 *  - `KEY=VALUE`
 *  - `KEY="VALUE"` or `KEY='VALUE'` (quotes stripped)
 *  - `${VAR}` interpolation against already-parsed keys, then `process.env`
 */
export const parseEnvFile = (filePath: string): Record<string, string> => {
  const content = readFileSync(filePath, 'utf8');
  const result: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (! trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;

    const key = trimmed.slice(0, eqIdx).trim().replace(/^export\s+/, '');
    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Interpolate ${VAR} against already-parsed values, then process.env
    value = value.replace(/\$\{([^}]+)\}/g, (_, name: string) =>
      result[name] ?? process.env[name] ?? '');

    result[key] = value;
  }

  return result;
};

/**
 * Load a .env file into process.env.
 * Only sets variables that are not already set.
 */
export const loadEnvFile = (filePath: string): void => {
  try {
    const parsed = parseEnvFile(filePath);

    for (const [key, value] of Object.entries(parsed)) {
      if (! process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // Silently ignore if file doesn't exist
  }
};

/**
 * Load .env.testing from a service's tests directory into process.env.
 */
export const loadTestingEnv = (testsDir: string): void => {
  loadEnvFile(resolve(testsDir, '.env.testing'));
};
