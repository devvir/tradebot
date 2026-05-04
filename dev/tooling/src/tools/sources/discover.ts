import fs from 'node:fs';
import path from 'node:path';

const DAY_PREFIX_RE = /^(\d{8})/;

/**
 * Extract the YYYYMMDD day prefix from a bare filename.
 * Returns null when the filename does not start with 8 digits.
 */
export function dayFromFilename(name: string): string | null {
  return DAY_PREFIX_RE.exec(path.basename(name))?.[1] ?? null;
}

/**
 * Parse a user-supplied date string into a normalized YYYYMMDD key.
 *
 * Accepts `YYYYMMDD` or `YYYY-MM-DD`; strips `-` then validates `^\d{8}$`.
 * Returns `null` for null / blank input. Throws a descriptive error on
 * anything else so the caller can surface it before starting any I/O.
 */
export function parseFromDay(raw: string | null | undefined): string | null {
  if (! raw) return null;

  const stripped = raw.replace(/-/g, '');

  if (! /^\d{8}$/.test(stripped)) {
    throw new Error(
      `Invalid --from date: "${raw}". Expected YYYYMMDD or YYYY-MM-DD (e.g. 20260101 or 2026-01-01).`,
    );
  }

  return stripped;
}

/**
 * Walk `root` and return every directory that directly contains at least one
 * `*.csv.gz` file. Descends into subdirectories that do not themselves contain
 * any `.csv.gz` files, so the typical `table/year/` structure is handled
 * transparently.
 *
 * When `root` is already a leaf (contains `.csv.gz` directly) it is returned
 * as the sole element.
 */
export function collectLeafFolders(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const hasCsvGz = entries.some(e => e.isFile() && e.name.endsWith('.csv.gz'));

  if (hasCsvGz) {
    return [root];
  }

  const leaves: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      leaves.push(...collectLeafFolders(path.join(root, entry.name)));
    }
  }

  return leaves;
}
