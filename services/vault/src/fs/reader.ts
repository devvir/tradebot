// Filesystem read operations.
//
// Responsible for: streaming closed files as parsed CSV records, checking
// file existence, listing files in a table directory, and walking the
// directory structure to enumerate all tables and dates.
//
// Vault stores only gzipped CSV, so the reader knows the format end-to-end.
// Routing CSV through the shared parser is what lets fields containing
// embedded newlines (e.g. announcement bodies, chat messages) round-trip
// correctly — a line-based reader would fragment them at the embedded `\n`
// before any consumer could see them as a single field.

import { existsSync, createReadStream, readdirSync, statSync } from 'fs';
import { createGunzip } from 'zlib';
import { createCsvParser } from '@tradebot/utils';
import { DATA_DIR, tableDir, openPath, closedPath } from './paths';
import { NotFoundError } from './errors';
import type { FileListing } from './types';

/**
 * Streams the records of a closed file, decompressing and CSV-parsing on the
 * fly. The first record is the header row; subsequent records are data rows.
 * Each record is a `string[]` in column order.
 *
 * Throws NotFoundError if no closed file exists for the given table/filename.
 * Open files are not readable — callers treat them as non-existent.
 */
export async function* streamRecords(table: string, filename: string): AsyncGenerator<string[]> {
  const path = closedPath(table, filename);

  if (! existsSync(path)) {
    throw new NotFoundError(`No closed file for ${table}/${filename}`);
  }

  const src    = createReadStream(path);
  const parser = src.pipe(createGunzip()).pipe(createCsvParser(false));

  try {
    for await (const record of parser as AsyncIterable<string[]>) {
      yield record;
    }
  } finally {
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
