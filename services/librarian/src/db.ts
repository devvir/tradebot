/**
 * Db-handle resolver: the default database plus per-request overrides
 * (`?db=`). Handles are cached per name — `mongo.db()` is cheap, but there is
 * no reason to build a fresh handle on every request for the same target.
 */

import type { MongoClient } from '@devvir/service-kit';
import type { Db } from 'mongodb';
import type { DbResolver } from './types';

export const makeDbResolver = (mongo: MongoClient, defaultDatabase: string): DbResolver => {
  const handles = new Map<string, Db>();

  return (name?: string): Db => {
    const database = name ?? defaultDatabase;

    let db = handles.get(database);

    if (! db) {
      db = mongo.db(database);
      handles.set(database, db);
    }

    return db;
  };
};
