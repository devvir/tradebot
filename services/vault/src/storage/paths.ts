import path from 'path';

export const DATA_DIR = '/data/vault';

export const tableDir   = (table: string):               string => path.join(DATA_DIR, table);
export const yearDir    = (table: string, date: string): string => path.join(tableDir(table), date.slice(0, 4));
export const openPath   = (table: string, date: string): string => path.join(yearDir(table, date), `${date}.csv.gz.tmp`);
export const closedPath = (table: string, date: string): string => path.join(yearDir(table, date), `${date}.csv.gz`);
