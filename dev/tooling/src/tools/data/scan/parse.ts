import { ALL_TABLE_NAMES } from './tables';
import { SUFFIX_PATTERN } from '../discover';

export interface ParsedVaultFile {
  table:  string;
  year:   string;
  day:    string;
  suffix: string;        // '' for buckets, e.g. 'local' / 'mtav' / 'local.1' for source files
  isTmp:  boolean;       // true if the filename ends in `.tmp` (download in progress)
}

const FILE_RE = new RegExp(`^(\\d{8})(${SUFFIX_PATTERN})?\\.csv\\.gz(\\.tmp)?$`);

/**
 * Parses a vault-relative path (after the table-level base) into its parts.
 *
 * Accepted shapes:
 *   - `<table>/<year>/YYYYMMDD.csv.gz`                    → bucket
 *   - `<table>/<year>/YYYYMMDD.<suffix>.csv.gz`          → source file (suffix may be multi-part, e.g. `local.1`)
 *   - `<table>/<year>/YYYYMMDD.csv.gz.tmp`               → bucket being downloaded
 *   - `<table>/<year>/YYYYMMDD.<suffix>.csv.gz.tmp`      → source file being downloaded
 *
 * Returns `null` for unknown tables, malformed years, or unexpected subfolders.
 */
export function parseVaultPath(relPath: string): ParsedVaultFile | null {
  const parts = relPath.split('/').filter(Boolean);

  if (parts.length !== 3)                           return null;

  const table = parts[0]!;
  const year  = parts[1]!;

  if (! ALL_TABLE_NAMES.has(table))                 return null;
  if (! /^\d{4}$/.test(year))                       return null;

  const filename = parts[2]!;
  const match    = FILE_RE.exec(filename);

  if (! match)                                      return null;

  const [, day, suffixRaw, tmpMarker] = match;
  const suffix = suffixRaw ? suffixRaw.slice(1) : '';
  const isTmp  = tmpMarker !== undefined;

  return { table, year, day: day!, suffix, isTmp };
}

/**
 * Parses a Mega-relative tar path, e.g. `orderBookL2/2021.tar`.
 *
 * Returns the year as a number, or `null` if the path doesn't match the
 * `<table>/YYYY.tar` shape for a known table.
 */
export function parseMegaTar(relPath: string): { table: string; year: number } | null {
  const parts = relPath.split('/').filter(Boolean);

  if (parts.length !== 2)                           return null;

  const table = parts[0]!;
  const match = /^(\d{4})\.tar$/.exec(parts[1]!);

  if (! ALL_TABLE_NAMES.has(table))                 return null;
  if (! match)                                      return null;

  return { table, year: Number(match[1]) };
}
