import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AT_CREATION, ON_OPEN } from './schema';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations';

/**
 * Open the catalog, creating it if absent and bringing it up to date if not.
 *
 * A present database is otherwise **not touched**: no repair, no rebuild, no
 * inference about what it ought to contain. Migrations are the single exception,
 * and they are explicit, versioned and applied once — which is different in kind
 * from a service deciding on its own initiative to rewrite twenty gigabytes.
 *
 * Creation is the only moment `auto_vacuum` can be set, and the only moment the
 * schema is written whole.
 */
export const openCatalog = (
  path: string,
  { seedData = true }: { seedData?: boolean } = {},
): DatabaseSync => {
  const fresh = ! existsSync(path);

  if (fresh) mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);

  // Before the schema and before WAL: `auto_vacuum` takes effect only on a
  // database with no tables in it yet.
  if (fresh) for (const pragma of AT_CREATION) db.exec(pragma);

  for (const pragma of ON_OPEN) db.exec(pragma);

  /**
   * **Every database, every time, from whatever version it is at.** A fresh file
   * reports 0 and runs the whole chain; one already at the head runs nothing.
   * There is no path that skips it — that is the whole point of a chain, and
   * the reason a seed can be written as a migration at all.
   */
  migrate(db, seedData);

  return db;
};

/**
 * Bring an existing database from whatever version it is at to the current one.
 *
 * Each migration runs **in its own transaction with its version bump**, so a
 * failure leaves the database exactly where it was rather than half-migrated,
 * and the next start retries the same step.
 *
 * A version *ahead* of this build is refused rather than ignored: it means an
 * older binary has been pointed at a newer catalog, and carrying on would write
 * rows the running code cannot describe.
 */
export const migrate = (db: DatabaseSync, seedData = true): number => {
  const from = version(db);

  if (from > SCHEMA_VERSION)
    throw new Error(
      `Catalog is at schema version ${from}, but this build only knows ${SCHEMA_VERSION}. ` +
      `Run a newer build, or point this one at a different catalog.`,
    );

  for (let at = from; at < SCHEMA_VERSION; at++) {
    const migration = MIGRATIONS[at]!;

    /**
     * **Declined, not skipped.** The version still moves: a caller that asked
     * for no shipped rows has the schema it wanted, and must not have this same
     * migration attempted again behind its back on the next open.
     */
    if (migration.seedData && ! seedData) {
      setVersion(db, at + 1);

      continue;
    }

    db.exec('BEGIN');

    try {
      if (migration.sql) db.exec(migration.sql);

      migration.run?.(db, seedData);
      setVersion(db, at + 1);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');

      throw new Error(
        `Migration ${at + 1} (${migration.name}) failed: ${(err as Error).message}`,
      );
    }
  }

  return SCHEMA_VERSION - from;
};

export const version = (db: DatabaseSync): number =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

/**
 * Whether this database can actually be written, asked at startup rather than
 * discovered by the first page of a survey hours later.
 *
 * Nothing earlier answers it. Opening a read-only file **succeeds**, and so does
 * `PRAGMA journal_mode = WAL` on a database already in WAL mode, since neither
 * writes anything. The probe therefore has to write to the main database itself:
 * `user_version` is set to the value it already holds, which changes nothing and
 * still needs a write transaction — so it fails on a read-only file and on a
 * read-only *directory*, where SQLite cannot create the `-wal` and `-shm`
 * sidecars.
 *
 * A read-only mount is the case worth catching, because it fails in the least
 * obvious way: a WAL **reader** needs the `-shm` sidecar, so a catalog mounted
 * read-only refuses plain `SELECT`s. Ownership between services is a code
 * boundary and cannot be delegated to the filesystem.
 */
export const assertWritable = (db: DatabaseSync, path: string): void => {
  try {
    setVersion(db, version(db));
  } catch (err) {
    throw new Error(
      `Catalog at '${path}' is not usable (${(err as Error).message}). ` +
      `A WAL database cannot be opened from a read-only mount: its readers ` +
      `write the -shm sidecar. Mount it read-write.`,
    );
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

// `PRAGMA user_version` takes no parameters, so the value is interpolated. It is
// our own integer and never comes from outside.
const setVersion = (db: DatabaseSync, to: number): void => {
  db.exec(`PRAGMA user_version = ${Math.trunc(to)}`);
};
