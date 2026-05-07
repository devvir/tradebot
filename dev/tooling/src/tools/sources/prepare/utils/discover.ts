import path from 'node:path';
import { PrepareGroup } from '../types';
import { KNOWN_TABLES } from '../../tables';

const DAY_PREFIX_RE = /^(\d{8})/;

/**
 * Group a flat list of `.csv.gz` file paths into PrepareGroups by
 * (parent folder, day). Each file's parent folder is the raw source folder;
 * `outputDir` is `<folder>/prepared`, `tableName` is derived from the path.
 */
export function discoverGroups(files: string[]): PrepareGroup[] {
  const byKey = new Map<string, { folder: string; day: string; paths: string[] }>();

  for (const file of files) {
    const folder = path.dirname(file);
    const m      = DAY_PREFIX_RE.exec(path.basename(file));

    if (! m) continue;

    const day = m[1]!;
    const key = `${folder}\0${day}`;

    if (! byKey.has(key)) byKey.set(key, { folder, day, paths: [] });

    byKey.get(key)!.paths.push(file);
  }

  const groups: PrepareGroup[] = [];

  for (const { folder, day, paths } of byKey.values()) {
    groups.push({
      day,
      folder,
      tableName:  tableNameFromFolder(folder),
      paths:      sortByPrioritySortKey(paths),
      outputDir:  path.join(folder, 'prepared'),
      outputName: `${day}.csv.gz`,
    });
  }

  return groups.sort((a, b) =>
    a.folder !== b.folder ? a.folder.localeCompare(b.folder) :
    a.day.localeCompare(b.day),
  );
}

/**
 * Sort by stem (extension stripped) so the primary file `YYYYMMDD.csv.gz`
 * precedes any sibling with an infix. Stripping is required: with full
 * names, `'20260411.a.csv.gz' < '20260411.csv.gz'` because `'a' < 'c'`.
 */
function sortByPrioritySortKey(filePaths: string[]): string[] {
  const key = (p: string): string => {
    const name = path.basename(p);

    return name.slice(0, -'.csv.gz'.length);
  };

  return [...filePaths].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);

    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Walk path components from deepest to root looking for a `KNOWN_TABLES`
 * match; fall back to the folder's basename.
 */
function tableNameFromFolder(folder: string): string {
  const parts = folder.split(path.sep);

  for (let i = parts.length - 1; i >= 0; i--)
    if (KNOWN_TABLES.has(parts[i]!)) return parts[i]!;

  return path.basename(folder);
}
