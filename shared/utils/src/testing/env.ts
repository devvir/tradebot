import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Parse a .env file and return the key-value pairs.
 *
 * Values are read as docker compose reads them:
 *  - blank lines and lines starting with `#` are skipped, as are lines with no `=`
 *  - `KEY=VALUE`, optionally prefixed with `export`
 *  - an unquoted value ends at a `#` that follows whitespace; a `#` with nothing
 *    before it is part of the value
 *  - `KEY='VALUE'` is taken as written, `${VAR}` included
 *  - `KEY="VALUE"` has its quotes stripped
 *  - a closing quote may be followed by whitespace and a `# comment`; a quote
 *    that does not close the value is part of it
 *
 * `${VAR}` in unquoted and double-quoted values is replaced with the value of
 * an earlier key in the file, else of `process.env`, else the empty string.
 */
export const parseEnvFile = (filePath: string): Record<string, string> => {
  const content = readFileSync(filePath, 'utf8');
  const result: Record<string, string> = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (! trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;

    const key = trimmed.slice(0, eqIdx).trim().replace(/^export\s+/, '');
    const { value, literal } = parseValue(trimmed.slice(eqIdx + 1).trim());

    result[key] = literal
      ? value
      : value.replace(/\$\{([^}]+)\}/g, (_, name: string) => result[name] ?? process.env[name] ?? '');
  }

  return result;
};

/**
 * Load a .env file into process.env. A variable that is already set, even to
 * the empty string, keeps its value. A file that does not exist loads nothing;
 * any other read error is thrown.
 */
export const loadEnvFile = (filePath: string): void => {
  let parsed: Record<string, string>;

  try {
    parsed = parseEnvFile(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
};

/**
 * Load .env.testing from a service's tests directory into process.env.
 */
export const loadTestingEnv = (testsDir: string): void => {
  loadEnvFile(resolve(testsDir, '.env.testing'));
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Nothing, or a comment, after a closing quote. */
const AFTER_QUOTE = /^(?:\s*|\s+#.*)$/;

/** One trimmed value as written after `=`; `literal` when it was single-quoted. */
const parseValue = (raw: string): { value: string; literal: boolean } => {
  const quote = raw[0];

  if (quote === '"' || quote === "'") {
    const end = raw.indexOf(quote, 1);

    if (end > 0 && AFTER_QUOTE.test(raw.slice(end + 1)))
      return { value: raw.slice(1, end), literal: quote === "'" };
  }

  return { value: raw.replace(/\s+#.*$/, ''), literal: false };
};
