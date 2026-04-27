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
 * Throws NotFoundError if no closed file exists for the given table/date.
 * Open files are not readable — callers treat them as non-existent.
 */
export async function* streamLines(table: string, date: string): AsyncGenerator<string> {
  const path = closedPath(table, date);

  if (! existsSync(path)) {
    throw new NotFoundError(`No closed file for ${table}/${date}`);
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

/** Returns whether the file for the given table/date is closed, open, or absent. */
export const fileState = (table: string, date: string): 'closed' | 'open' | 'none' => {
  if (existsSync(closedPath(table, date))) return 'closed';
  if (existsSync(openPath(table, date)))   return 'open';

  return 'none';
};

/** Lists all dates for a table and their state. Returns null if the table directory does not exist. */
export const listFiles = (table: string): FileListing | null => {
  const dir = tableDir(table);

  if (! existsSync(dir)) return null;

  const result: FileListing = {};

  for (const year of readdirSync(dir)) {
    const yDir = `${dir}/${year}`;

    if (! statSync(yDir).isDirectory()) continue;

    for (const file of readdirSync(yDir)) {
      if (file.endsWith('.csv.gz.tmp')) {
        result[file.replace('.csv.gz.tmp', '')] = 'open';
      } else if (file.endsWith('.csv.gz')) {
        result[file.replace('.csv.gz', '')] = 'closed';
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
