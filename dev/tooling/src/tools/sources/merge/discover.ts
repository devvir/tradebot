import fs from 'node:fs';
import path from 'node:path';
import type { FileGroup } from '../types.js';

const YYYYMMDD_RE = /^(\d{8})/;

const KNOWN_TABLES = new Set([
  'announcement',
  'chat',
  'connected',
  'instrument',
  'liquidation',
  'orderBookL2',
  'publicNotifications',
]);

export interface DiscoveryResult {
  /** Groups of 2+ files ready to be merged, sorted by day. */
  toMerge: FileGroup[];
  /** Days with exactly one file — nothing to merge. */
  singletons: Array<{ day: string; path: string }>;
  /** Days where YYYYMMDD.merged.csv.gz already exists — skipped. */
  alreadyMerged: Array<{ day: string; outputPath: string }>;
  /** Leftover .tmp crash files to clean up on startup. */
  tmpFiles: string[];
}

/**
 * Parse a user-supplied date string into a normalized YYYYMMDD key.
 *
 * Accepts `YYYYMMDD` or `YYYY-MM-DD`; strips `-` then validates `^\d{8}$`.
 * Returns `null` for null / blank input. Throws a descriptive error on
 * anything else so the caller can surface it before starting any I/O.
 */
export function parseFromDay(raw: string | null | undefined): string | null {
  if (! raw) {
    return null;
  }

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

/**
 * Scan a single flat folder for *.csv.gz files and classify them by day.
 * Thin FS wrapper over the pure `groupFilesByDay`.
 *
 * When `fromDay` is supplied, any day whose YYYYMMDD key is strictly before
 * it is skipped entirely (moved neither to `toMerge`, `singletons`, nor
 * `alreadyMerged`).
 */
export function discoverGroups(folder: string, fromDay?: string): DiscoveryResult {
  const all = fs.readdirSync(folder);

  const csvGzNames = sortByPrioritySortKey(all.filter(name => name.endsWith('.csv.gz')));
  const tmpFiles   = all
    .filter(name => name.endsWith('.merged.csv.gz.tmp'))
    .map(name => path.join(folder, name));

  return { ...groupFilesByDay(folder, csvGzNames, fromDay), tmpFiles };
}

/**
 * Sort .csv.gz filenames with the `.csv.gz` extension stripped before
 * comparison. This is purely alphabetical — the primary file
 * (`YYYYMMDD.csv.gz`) naturally precedes any sibling that carries an extra
 * infix because `'20260411' < '20260411.a'` in standard string order (prefix
 * of a longer string sorts first). With the full names, a naive sort would
 * reverse this because `'a' < 'c'` at the first differing character.
 */
export function sortByPrioritySortKey(csvGzNames: string[]): string[] {
  const key = (name: string): string => name.slice(0, -'.csv.gz'.length);

  return [...csvGzNames].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);

    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Pure classification of a sorted list of bare *.csv.gz filenames.
 *
 * Groups files by their first 8 characters (YYYYMMDD), then classifies each
 * group:
 *
 *  - Day is before `fromDay` → silently skipped (not reported in any bucket).
 *  - Already has a YYYYMMDD.merged.csv.gz → `alreadyMerged`, skipped.
 *  - Exactly one file → `singletons`, skipped.
 *  - Two or more files → `toMerge`, sorted alphabetically within the group.
 *
 * Alphabetical sort within a group is the priority order: a file named
 * `20250101.csv.gz` sorts before `20250101.gap.1.csv.gz`, so the primary
 * file always leads.
 *
 * `folder` is used only to construct absolute `paths` and `outputPath` in
 * the returned objects — no filesystem access is performed.
 */
export function groupFilesByDay(
  folder:           string,
  sortedCsvGzNames: string[],
  fromDay?:         string,
): Omit<DiscoveryResult, 'tmpFiles'> {
  const tableName = tableNameFromFolder(folder);

  const byDay = new Map<string, string[]>();

  for (const name of sortedCsvGzNames) {
    const m = YYYYMMDD_RE.exec(name);

    if (! m) {
      continue;
    }

    const day = m[1]!;

    if (fromDay && day < fromDay) {
      continue;
    }

    if (! byDay.has(day)) {
      byDay.set(day, []);
    }

    byDay.get(day)!.push(path.join(folder, name));
  }

  const toMerge: FileGroup[] = [];
  const singletons: Array<{ day: string; path: string }> = [];
  const alreadyMerged: Array<{ day: string; outputPath: string }> = [];

  for (const [day, paths] of [...byDay.entries()].sort()) {
    const outputPath = path.join(folder, `${day}.merged.csv.gz`);
    const outputName = `${day}.merged.csv.gz`;

    // If the merged output is already among the group's files, skip.
    if (paths.some(p => path.basename(p) === outputName)) {
      alreadyMerged.push({ day, outputPath });
      continue;
    }

    if (paths.length === 1) {
      singletons.push({ day, path: paths[0]! });
      continue;
    }

    toMerge.push({ day, paths, outputPath, tableName });
  }

  return { toMerge, singletons, alreadyMerged };
}

/**
 * Derive a table name from a folder path by searching for a known table name
 * among the path components, walking from the deepest component upward.
 * Falls back to the folder's basename when no known table is found.
 */
export function tableNameFromFolder(folder: string): string {
  const parts = folder.split(path.sep);

  for (let i = parts.length - 1; i >= 0; i--) {
    if (KNOWN_TABLES.has(parts[i]!)) {
      return parts[i]!;
    }
  }

  return path.basename(folder);
}
