import type { Db } from 'mongodb';

export interface Config {
  database:         string;
  ignoreDuplicates: boolean;
  [key: string]:    unknown;
}

/**
 * Resolves a database name to a cached `Db` handle. Called with no argument it
 * returns the default database; per-request overrides (`?db=`) pass the name.
 */
export type DbResolver = (name?: string) => Db;

/** Callbacks fired by every successful op — feed the throughput metrics. */
export type InsertCounter = (n: number) => void;
export type ReadCounter   = (n: number) => void;
