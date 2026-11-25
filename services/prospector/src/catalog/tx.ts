import type { DatabaseSync } from 'node:sqlite';

/**
 * Run `work` inside one transaction: committed if it returns, rolled back if it
 * throws.
 *
 * **The error that escapes is the one `work` threw.** SQLite rolls a
 * transaction back by itself on some failures — a full disk, an I/O error,
 * `RAISE(ROLLBACK)` in a trigger — so a `ROLLBACK` is issued only while one is
 * still open. Where the rollback fails as well, its error is attached to the
 * original as `cause` and the original is what is thrown.
 *
 * **`join` runs `work` inside a transaction already open**, so that it commits
 * or rolls back with the caller's. Without it, a call made inside a transaction
 * throws before `work` runs, since SQLite does not nest them.
 *
 * `work` is synchronous: an `await` inside it would hand the loop to another
 * writer with the transaction still open.
 */
export const inTransaction = <T>(
  db:       DatabaseSync,
  work:     () => T,
  { join = false }: { join?: boolean } = {},
): T => {
  if (join && db.isTransaction) return work();

  db.exec('BEGIN');

  try {
    const out = work();

    db.exec('COMMIT');

    return out;
  } catch (err) {
    if (db.isTransaction)
      try {
        db.exec('ROLLBACK');
      } catch (failed) {
        if (err instanceof Error && err.cause === undefined) err.cause = failed;
      }

    throw err;
  }
};
