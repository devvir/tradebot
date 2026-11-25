import { DatabaseSync } from 'node:sqlite';
import { idOf } from '../keys';
import { noteReturn } from './evictions';
import type { Origin } from '../../types';
import type { PartitionKey } from '../types';

/** A partition was brought back from cold storage into the archives, at this version. */
export const notePulled = (db: DatabaseSync, origin: Origin, key: PartitionKey & { version: string }): void => {
  db.prepare(
    `INSERT INTO pulled (origin, venue, market, dataset, variant, grain, bundle, month, version, pulled_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (origin, venue, market, dataset, variant, grain, bundle, month)
       DO UPDATE SET version = excluded.version, pulled_at = excluded.pulled_at`,
  ).run(origin, key.venue, key.market, key.dataset, key.variant, key.grain, key.bundle, key.month, key.version,
    new Date().toISOString());
};

/**
 * A partition is back in the archives because a pull brought it: no longer
 * away, and pulled, at this version. Both in one transaction, so no reader
 * ever sees it back on disk and not yet pulled.
 */
export const noteBack = (db: DatabaseSync, origin: Origin, key: PartitionKey & { version: string }): void => {
  db.exec('BEGIN IMMEDIATE');

  try {
    noteReturn(db, origin, key);
    notePulled(db, origin, key);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');

    throw err;
  }
};

/** The partitions of a venue brought back by a pull and not taken off the disk since, by partition. */
export const pulledOf = (db: DatabaseSync, origin: Origin, venue: string): Set<string> =>
  new Set((db.prepare(
    'SELECT venue, market, dataset, variant, grain, bundle, month FROM pulled WHERE origin = ? AND venue = ?',
  ).all(origin, venue) as unknown as PartitionKey[]).map(idOf));
