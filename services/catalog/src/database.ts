import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { logger } from '@devvir/service-kit';

/**
 * The catalog database, opened as it is.
 *
 * **Prospector's, not this service's.** It is created and migrated there, so
 * this never creates a table or a file: it waits for the database to exist and
 * opens it. The one write made here is a lens.
 *
 * **Reads stay short.** A read transaction held open stops prospector's
 * checkpoints, so the write-ahead log grows for as long as it lasts — which is
 * why every view here pages or answers from the partitions rather than walking a
 * table in one statement.
 */
export const openCatalog = async (path: string): Promise<DatabaseSync> => {
  while (! existsSync(path)) {
    logger.warn({ path }, 'The catalog does not exist yet — waiting for prospector to create it');

    await new Promise(done => setTimeout(done, 10_000));
  }

  const db = new DatabaseSync(path);

  // A lens save waits for prospector's current write rather than failing.
  db.exec('PRAGMA busy_timeout = 5000');

  return db;
};
