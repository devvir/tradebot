// Filesystem read operations.
//
// Responsible for: streaming raw file contents, checking file existence,
// listing files in a table directory, and walking the directory structure
// to enumerate all tables and dates.
// No knowledge of what the bytes mean — decoding and parsing belong in data/.

import { existsSync, createReadStream, readdirSync, statSync } from 'fs';
import { createInterface } from 'readline';
import { createGunzip } from 'zlib';
import { DATA_DIR, tableDir, openPath, closedPath } from './paths';
import { NotFoundError } from './errors';
import type { FileListing } from './types';

/**
 * Streams the lines of a closed file, decompressing on the fly.
 * Throws NotFoundError if no closed file exists for the given table/filename.
 * Open files are not readable — callers treat them as non-existent.
 */
export async function* streamLines(table: string, filename: string): AsyncGenerator<string> {
  const path = closedPath(table, filename);

  if (! existsSync(path)) {
    throw new NotFoundError(`No closed file for ${table}/${filename}`);
  }

  const src = createReadStream(path);
  const rl  = createInterface({
    input:     src.pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (line) yield line;
    }
  } finally {
    rl.close();
    src.destroy();
  }
}

/** Returns whether the file for the given table/filename is closed, open, or absent. */
export const fileState = (table: string, filename: string): 'closed' | 'open' | 'none' => {
  if (existsSync(closedPath(table, filename))) return 'closed';
  if (existsSync(openPath(table, filename)))   return 'open';

  return 'none';
};

/**
 * Lists filenames for a table and their state. Returns null if the table
 * directory does not exist.
 *
 * `suffix` filters by the file tag:
 *   - omitted / empty → bare-date files only (stem contains no `.`)
 *   - `'snapshot'`    → suffixed files only (stem ends with `.snapshot`)
 */
export const listFiles = (table: string, suffix?: string): FileListing | null => {
  const dir = tableDir(table);

  if (! existsSync(dir)) return null;

  const matches = suffix
    ? (stem: string) => stem.endsWith(`.${suffix}`)
    : (stem: string) => ! stem.includes('.');

  const result: FileListing = {};

  for (const year of readdirSync(dir)) {
    const yDir = `${dir}/${year}`;

    if (! statSync(yDir).isDirectory()) continue;

    for (const file of readdirSync(yDir)) {
      let stem: string;

      if (file.endsWith('.csv.gz.tmp')) {
        stem = file.replace('.csv.gz.tmp', '');
        if (matches(stem)) result[stem] = 'open';
      } else if (file.endsWith('.csv.gz')) {
        stem = file.replace('.csv.gz', '');
        if (matches(stem)) result[stem] = 'closed';
      }
    }
  }

  return result;
};

/** Lists all table names that have at least one file in vault. */
export const listTables = (): string[] => {
  if (! existsSync(DATA_DIR)) return [];

  return readdirSync(DATA_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
};
