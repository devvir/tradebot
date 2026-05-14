import fs from 'node:fs';
import path from 'node:path';
import { ALL_TABLES } from './tables';
import { parseVaultPath } from './parse';

export interface LocalEntry {
  table:   string;
  year:    string;
  day:     string;
  suffix:  string;            // '' for buckets
  isTmp:   boolean;
  absPath: string;
}

/**
 * Walks the local vault root and returns every recognized `.csv.gz`(`.tmp`)
 * file (source files, buckets, and in-progress downloads). Sources and the
 * resulting bucket live side by side in the year folder.
 *
 * Anything not matching the layout is skipped silently — stray artifacts
 * aren't part of state.
 */
export function scanLocal(localBase: string): LocalEntry[] {
  const entries: LocalEntry[] = [];

  for (const { name: table } of ALL_TABLES) {
    const tableDir = path.join(localBase, table);

    if (! existsDir(tableDir)) continue;

    for (const year of listYearDirs(tableDir)) {
      collectDir(localBase, path.join(tableDir, year), entries);
    }
  }

  return entries;
}

function collectDir(localBase: string, dir: string, out: LocalEntry[]): void {
  for (const filename of fs.readdirSync(dir)) {
    const abs    = path.join(dir, filename);
    const rel    = path.relative(localBase, abs);
    const parsed = parseVaultPath(rel);

    if (! parsed) continue;

    out.push({
      table:   parsed.table,
      year:    parsed.year,
      day:     parsed.day,
      suffix:  parsed.suffix,
      isTmp:   parsed.isTmp,
      absPath: abs,
    });
  }
}

function listYearDirs(tableDir: string): string[] {
  return fs.readdirSync(tableDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^\d{4}$/.test(e.name))
    .map(e => e.name)
    .sort();
}

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
