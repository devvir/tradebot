import path from 'path';

export const DATA_DIR = '/data/vault';

/**
 * Every path below is resolved and must lie strictly inside DATA_DIR; one that
 * would not (a `..` or `/` in a table or filename) throws instead of being
 * returned.
 */
const inDataDir = (p: string): string => {
  const resolved = path.resolve(p);

  if (! resolved.startsWith(DATA_DIR + path.sep))
    throw new Error(`Path outside the data directory: ${p}`);

  return resolved;
};

export const tableDir   = (table: string):                   string => inDataDir(path.join(DATA_DIR, table));
export const yearDir    = (table: string, filename: string): string => inDataDir(path.join(tableDir(table), filename.slice(0, 4)));
export const openPath   = (table: string, filename: string): string => inDataDir(path.join(yearDir(table, filename), `${filename}.csv.gz.tmp`));
export const closedPath = (table: string, filename: string): string => inDataDir(path.join(yearDir(table, filename), `${filename}.csv.gz`));
