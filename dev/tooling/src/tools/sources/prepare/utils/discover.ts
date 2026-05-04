import fs from 'node:fs';
import path from 'node:path';
import { PrepareGroup } from '../types';
import { KNOWN_TABLES } from '../../tables';
import { fromDay } from '../../options';

const DAY_PREFIX_RE = /^(\d{8})/;

export function discoverGroups(folder: string): PrepareGroup[] {
  const tableName = tableNameFromFolder(folder);
  const cutDay    = fromDay();
  const entries   = fs.readdirSync(folder, { withFileTypes: true });

  const csvGzNames = sortByPrioritySortKey(
    entries.filter(e => e.isFile() && e.name.endsWith('.csv.gz')).map(e => e.name),
  );

  const byDay = new Map<string, string[]>();

  for (const name of csvGzNames) {
    const m = DAY_PREFIX_RE.exec(name);

    if (! m) {
      continue;
    }

    const day = m[1]!;

    if (cutDay && day < cutDay)
      continue;

    if (! byDay.has(day))
      byDay.set(day, []);

    byDay.get(day)!.push(path.join(folder, name));
  }

  const outputDir = path.join(folder, 'prepared');
  const out: PrepareGroup[] = [];

  for (const [day, paths] of [...byDay.entries()].sort()) {
    out.push({
      day,
      folder,
      tableName,
      paths,
      outputDir,
      outputName: `${day}.csv.gz`,
    });
  }

  return out;
}

/**
 * Sort .csv.gz filenames with the `.csv.gz` extension stripped before
 * comparison. This is purely alphabetical — the primary file
 * (`YYYYMMDD.csv.gz`) naturally precedes any sibling that carries an extra
 * infix because `'20260411' < '20260411.a'` in standard string order (prefix
 * of a longer string sorts first). With the full names, a naive sort would
 * reverse this because `'a' < 'c'` at the first differing character.
 */
function sortByPrioritySortKey(csvGzNames: string[]): string[] {
  const key = (name: string): string => name.slice(0, -'.csv.gz'.length);

  return [...csvGzNames].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);

    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Derive a table name from a folder path by searching for a known table name
 * among the path components, walking from the deepest component upward.
 * Falls back to the folder's basename when no known table is found.
 */
function tableNameFromFolder(folder: string): string {
  const parts = folder.split(path.sep);

  for (let i = parts.length - 1; i >= 0; i--)
    if (KNOWN_TABLES.has(parts[i]!)) return parts[i]!;

  return path.basename(folder);
}
