// Filesystem read operations.
//
// Responsible for: opening closed files as decompressed byte streams, checking
// file existence, listing files in a table directory, and walking the directory
// structure to enumerate all tables and dates.
//
// Turning those bytes into records is the parser's concern — see data/parse.ts,
// which owns the CSV format and the per-table parsing strategy.

import { existsSync, readdirSync, statSync } from 'fs';
import { createReader } from '@devvir/zipper';
import { DATA_DIR, tableDir, openPath, closedPath } from './paths';
import { NotFoundError } from './errors';
import type { FileListing, OpenedFile } from './types';

/**
 * Opens a closed file as a decompressed byte stream. The caller MUST invoke
 * the returned `close` once finished to release the underlying file handle.
 *
 * Throws NotFoundError if no closed file exists for the given table/filename.
 * Open files are not readable — callers treat them as non-existent.
 */
export const openClosedFile = (table: string, filename: string): OpenedFile => {
  const path = closedPath(table, filename);

  if (! existsSync(path)) {
    throw new NotFoundError(`No closed file for ${table}/${filename}`);
  }

  const reader = createReader(path);

  return {
    stream: reader.stream(),
    close:  () => reader.close(),
  };
};

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
    if (! /^\d{4}$/.test(year)) continue;

    const yDir = `${dir}/${year}`;

    if (! statSync(yDir).isDirectory()) continue;

    for (const file of readdirSync(yDir)) {
      let stem: string;

      if (file.endsWith('.csv.gz.tmp')) {
        stem = file.replace('.csv.gz.tmp', '');
      } else if (file.endsWith('.csv.gz')) {
        stem = file.replace('.csv.gz', '');
      } else {
        continue;
      }

      // Stem must start with YYYYMMDD where YYYY matches the year dir.
      if (! /^\d{8}(\.|$)/.test(stem) || stem.slice(0, 4) !== year)
        continue;

      if (matches(stem))
        result[stem] = file.endsWith('.tmp') ? 'open' : 'closed';
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
