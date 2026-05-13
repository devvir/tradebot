import fs from 'node:fs';
import path from 'node:path';
import { KNOWN_TABLES } from './tables';
import { fromDay } from './options';

const DAY_PREFIX_RE = /^(\d{8})/;

/**
 * The suffix portion of a source filename: one or more `.segment` groups,
 * each segment being any run of non-dot characters. The filesystem decides
 * which characters are valid — this pattern just accepts them.
 *
 * Single source of truth for "what is a suffix", shared with the vault-path
 * parser in `scan/parse.ts`.
 */
export const SUFFIX_PATTERN = '(?:\\.[^.]+)+';

/** Matches only suffixed source files, e.g. `20260412.local.csv.gz`. */
export const SUFFIXED_SOURCE_RE = new RegExp(`^\\d{8}${SUFFIX_PATTERN}\\.csv\\.gz$`);

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
 * Resolve an absolute path argument into the list of `.csv.gz` files under it.
 * Returns sources and buckets alike — filtering by file type is a caller
 * concern. Patterns are tried in this order:
 *
 *   3.  <table>/<YYYY>/(\d{1,7} | YYYYMMDD | YYYYMMDD.csv.gz)
 *       Day prefix, exact day, or exact file. Year dir must exist.
 *   4a. <table>/\d{1,3}
 *       Year prefix (e.g. "202" matches all 202x). Table dir must exist.
 *   4b. <table>/\d{4}
 *       Whole year. Year dir must exist.
 *   5.  <table>
 *       Whole table. Table dir must exist.
 *   6.  <any-other-existing-dir>
 *       Treated as a base whose direct children are KNOWN_TABLES (no recursion).
 *
 * Throws when the resolved dir does not exist. Returns `[]` (no error) when
 * the dir is valid but contains nothing matching. Applies the `fromDay()`
 * filter to the result.
 */
export function resolveCsvGzFiles(absPath: string): string[] {
  const normalized = absPath.replace(/\/+$/, '') || absPath;
  const last       = path.basename(normalized);
  const last2      = path.basename(path.dirname(normalized));
  const last3      = path.basename(path.dirname(path.dirname(normalized)));

  const files = (() => {
    if (KNOWN_TABLES.has(last3) && /^\d{4}$/.test(last2))    return resolvePattern3(normalized, last);
    if (KNOWN_TABLES.has(last2) && /^\d{1,3}$/.test(last))   return resolvePattern4a(normalized, last);
    if (KNOWN_TABLES.has(last2) && /^\d{4}$/.test(last))     return resolvePattern4b(normalized);
    if (KNOWN_TABLES.has(last))                              return resolvePattern5(normalized);

    return resolvePattern6(normalized);
  })();

  return applyFromDayFilter(files);
}

/**
 * For a suffixed source file `<dir>/<day>.<infix>.csv.gz`, returns true when
 * no bucket `<dir>/<day>.csv.gz` (or its `.tmp`) is already present. Used by
 * `sources prepare` to skip days whose bucket is already built.
 */
export function noBucketYet(file: string): boolean {
  const day    = path.basename(file).slice(0, 8);
  const bucket = path.join(path.dirname(file), `${day}.csv.gz`);

  return ! fs.existsSync(bucket) && ! fs.existsSync(`${bucket}.tmp`);
}

// ── Pattern resolvers ────────────────────────────────────────────────────────

function resolvePattern3(normalized: string, last: string): string[] {
  const yearDir = path.dirname(normalized);

  ensureDir(yearDir);

  // 1-8 digit day prefix → match all matching files (incl. `.<infix>.csv.gz` siblings)
  if (/^\d{1,8}$/.test(last)) {
    return listCsvGzWithPrefix(yearDir, last);
  }

  // Exact file: YYYYMMDD[.<infix>].csv.gz → just that one file
  if (/^\d{8}(?:\..+)?\.csv\.gz$/.test(last)) {
    const file = path.join(yearDir, last);

    return fs.existsSync(file) ? [file] : [];
  }

  throw new Error(
    `Invalid sources path: "${last}" must be 1-8 digits or YYYYMMDD[.infix].csv.gz`,
  );
}

function resolvePattern4a(normalized: string, yearPrefix: string): string[] {
  const tableDir = path.dirname(normalized);

  ensureDir(tableDir);

  const years = listYearDirs(tableDir).filter(y => path.basename(y).startsWith(yearPrefix));

  return years.flatMap(listCsvGz);
}

function resolvePattern4b(normalized: string): string[] {
  ensureDir(normalized);

  return listCsvGz(normalized);
}

function resolvePattern5(normalized: string): string[] {
  ensureDir(normalized);

  return listYearDirs(normalized).flatMap(listCsvGz);
}

function resolvePattern6(normalized: string): string[] {
  ensureDir(normalized);

  const tableDirs = fs.readdirSync(normalized, { withFileTypes: true })
    .filter(e => e.isDirectory() && KNOWN_TABLES.has(e.name))
    .map(e => path.join(normalized, e.name));

  return tableDirs.flatMap(t => listYearDirs(t).flatMap(listCsvGz));
}

// ── Listing helpers ──────────────────────────────────────────────────────────

function listCsvGz(dir: string): string[] {
  return fs.readdirSync(dir)
    .filter(n => n.endsWith('.csv.gz') && DAY_PREFIX_RE.test(n))
    .map(n => path.join(dir, n))
    .sort();
}

function listCsvGzWithPrefix(dir: string, prefix: string): string[] {
  return fs.readdirSync(dir)
    .filter(n => n.endsWith('.csv.gz') && n.startsWith(prefix) && DAY_PREFIX_RE.test(n))
    .map(n => path.join(dir, n))
    .sort();
}

function listYearDirs(tableDir: string): string[] {
  return fs.readdirSync(tableDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^\d{4}$/.test(e.name))
    .map(e => path.join(tableDir, e.name))
    .sort();
}

// ── Validation ───────────────────────────────────────────────────────────────

function ensureDir(p: string): void {
  let stat;

  try {
    stat = fs.statSync(p);
  } catch {
    throw new Error(`Path does not exist: ${p}`);
  }

  if (! stat.isDirectory()) {
    throw new Error(`Path exists but is not a directory: ${p}`);
  }
}

// ── --from filter ────────────────────────────────────────────────────────────

function applyFromDayFilter(files: string[]): string[] {
  const cutDay = fromDay();

  if (! cutDay) return files;

  return files.filter(f => {
    const m = DAY_PREFIX_RE.exec(path.basename(f));

    return m ? m[1]! >= cutDay : false;
  });
}
