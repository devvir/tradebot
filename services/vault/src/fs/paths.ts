import path from 'path';

export const DATA_DIR = '/data/vault';

export const tableDir   = (table: string):                   string => path.join(DATA_DIR, table);
export const yearDir    = (table: string, filename: string): string => path.join(tableDir(table), filename.slice(0, 4));
export const openPath   = (table: string, filename: string): string => path.join(yearDir(table, filename), `${filename}.csv.gz.tmp`);
export const closedPath = (table: string, filename: string): string => path.join(yearDir(table, filename), `${filename}.csv.gz`);
