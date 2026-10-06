import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { logger } from '@devvir/service-kit';

/**
 * The catalog database, opened as it is.
 *
 * **Prospector's, not this service's, and opened read-only.** It is created,
 * migrated and written there and nowhere else: two writers on one file wait on
 * each other's locks, and the one that waits longest fails. So this connection
 * cannot write — a statement that tries is refused by the engine, which is the
 * point: the rule does not depend on anybody remembering it.
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

  return new DatabaseSync(path, { readOnly: true });
};
