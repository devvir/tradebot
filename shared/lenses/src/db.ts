import type { DatabaseSync } from 'node:sqlite';

/** One transaction, so a step is never read half written. */
export const writing = (db: DatabaseSync, work: () => void): void => {
  db.exec('BEGIN IMMEDIATE');

  try {
    work();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');

    throw err;
  }
};
