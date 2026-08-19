import type { DatabaseSync } from 'node:sqlite';
import type { FileEffect, MonthDelta, MonthRow, MonthDrift } from '../../types';

/**
 * The venue-month rollup: how many files, how large, how many still to
 * download, how many the venue has withdrawn.
 *
 * **Why a cache at all.** Every one of those is an aggregate over `file`, which
 * is tens of gigabytes, so asking directly is not a slow query but an outage —
 * and they are the most ordinary questions anyone has. A limit does not rescue
 * them either: "is there anything left for this venue" still reads a million
 * rows to answer *no*.
 *
 * **Why only this one.** A cache is not free — it is one more thing to keep
 * true, one more place to be wrong in silence, and one more thing to read before
 * you can follow the code. This one earns it because the questions are constant,
 * the answers are expensive, and the grain is the one everything downstream
 * already speaks in. A cache that would teach the catalog something new about
 * the data — what a symbol is, what a dataset means — costs coupling as well as
 * maintenance, and has to justify both.
 */

/**
 * What a batch of writes does to the rollup, worked out without touching the
 * database.
 *
 * **Pure, and per batch rather than per row.** A survey page is a thousand keys
 * across one or two months, so folding first turns a thousand row updates into
 * one or two — and leaves the arithmetic testable on its own, which is the half
 * most likely to be wrong.
 *
 * A file that moved between months is handled by construction: its old state is
 * subtracted from the month it was in and its new state added to the month it is
 * now in, which are simply two different keys.
 */
export const deltasOf = (effects: readonly FileEffect[]): MonthDelta[] => {
  const byKey = new Map<string, MonthDelta>();

  const at = (venueId: number, month: string): MonthDelta => {
    const key   = `${venueId}|${month}`;
    const found = byKey.get(key)
      ?? { venueId, month, files: 0, bytes: 0, pending: 0, pendingBytes: 0, withdrawn: 0 };

    byKey.set(key, found);

    return found;
  };

  for (const { venueId, was, now } of effects) {
    if (was) {
      const cell = at(venueId, was.month);

      if (was.confirmed) {
        cell.files--;
        cell.bytes -= was.bytes;

        if (! was.downloaded) {
          cell.pending--;
          cell.pendingBytes -= was.bytes;
        }
      } else cell.withdrawn--;
    }

    const cell = at(venueId, now.month);

    if (now.confirmed) {
      cell.files++;
      cell.bytes += now.bytes;

      if (! now.downloaded) {
        cell.pending++;
        cell.pendingBytes += now.bytes;
      }
    } else cell.withdrawn++;
  }

  // A batch that only restates what was already there nets to nothing, and
  // writing those rows would be work to change no number.
  return [...byKey.values()].filter(moves);
};

/**
 * Apply deltas to the rollup.
 *
 * **The caller's transaction is the point.** This never opens one of its own, so
 * the counters move with the rows they describe or not at all — a cache updated
 * in a transaction of its own is a cache that is wrong whenever the two disagree,
 * and nothing would notice.
 */
export const apply = (db: DatabaseSync, deltas: readonly MonthDelta[]): void => {
  if (deltas.length === 0) return;

  const upsert = db.prepare(
    `INSERT INTO month (venue_id, month, files, bytes, pending, pending_bytes, withdrawn)
          VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue_id, month) DO UPDATE SET
          files         = month.files         + excluded.files,
          bytes         = month.bytes         + excluded.bytes,
          pending       = month.pending       + excluded.pending,
          pending_bytes = month.pending_bytes + excluded.pending_bytes,
          withdrawn     = month.withdrawn     + excluded.withdrawn`,
  );

  for (const d of deltas)
    upsert.run(d.venueId, d.month, d.files, d.bytes, d.pending, d.pendingBytes, d.withdrawn);
};

/**
 * Recompute the whole rollup from `file`.
 *
 * **A full read of the largest table, so it is never run on startup.** It exists
 * for the one case incremental maintenance cannot cover — switching the cache on
 * over a catalog written before it existed — and as the honest answer to "is the
 * cache still true", via `drift` below.
 */
export const rebuild = (db: DatabaseSync): void => {
  db.exec('BEGIN');

  try {
    db.exec('DELETE FROM month');
    db.exec(REBUILD);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');

    throw err;
  }
};

/**
 * Where the cache and the rows disagree, without changing either.
 *
 * **Every counter moves in the same transaction as its row, but a call site
 * nobody wired is silent** — that is the standing risk of any cache, and the
 * only honest answer to it is to be able to check. Same read as `rebuild`, so it
 * is the same cost and the same statement; what differs is that this reports
 * rather than overwrites.
 */
export const drift = (db: DatabaseSync): MonthDrift[] => {
  const rows = db.prepare(
    `WITH truth AS (${TRUTH})
     SELECT COALESCE(t.venue_id, m.venue_id) AS venueId,
            COALESCE(t.month,    m.month)    AS month,
            COALESCE(t.files, 0)     AS files,     COALESCE(m.files, 0)     AS cachedFiles,
            COALESCE(t.bytes, 0)     AS bytes,     COALESCE(m.bytes, 0)     AS cachedBytes,
            COALESCE(t.pending, 0)   AS pending,   COALESCE(m.pending, 0)   AS cachedPending,
            COALESCE(t.pending_bytes, 0) AS pendingBytes,
            COALESCE(m.pending_bytes, 0) AS cachedPendingBytes,
            COALESCE(t.withdrawn, 0) AS withdrawn, COALESCE(m.withdrawn, 0) AS cachedWithdrawn
       FROM truth t
       FULL OUTER JOIN month m ON m.venue_id = t.venue_id AND m.month = t.month
      WHERE COALESCE(t.files, 0)     <> COALESCE(m.files, 0)
         OR COALESCE(t.bytes, 0)     <> COALESCE(m.bytes, 0)
         OR COALESCE(t.pending, 0)   <> COALESCE(m.pending, 0)
         OR COALESCE(t.pending_bytes, 0) <> COALESCE(m.pending_bytes, 0)
         OR COALESCE(t.withdrawn, 0) <> COALESCE(m.withdrawn, 0)`,
  ).all() as unknown as MonthDrift[];

  return rows;
};

/** Every venue-month the rollup holds anything for, and what it holds. */
export const months = (
  db:      DatabaseSync,
  venueId: number,
): MonthRow[] =>
  db.prepare(
    `SELECT venue_id AS venueId, month, files, bytes, pending,
            pending_bytes AS pendingBytes, withdrawn
       FROM month WHERE venue_id = ? ORDER BY month`,
  ).all(venueId) as unknown as MonthRow[];

// ── Internals ─────────────────────────────────────────────────────────────────

/** Whether a delta says anything. */
const moves = (d: MonthDelta): boolean =>
  d.files !== 0 || d.bytes !== 0 || d.pending !== 0 || d.pendingBytes !== 0 || d.withdrawn !== 0;

/**
 * The rollup as the rows themselves say it is.
 *
 * `date` is `yyyymmdd` and the grain is the month, so the key is its first six
 * characters — the one place this cache interprets a stored value, and it is
 * interpreting a field the catalog already owns rather than learning something
 * new about the data.
 */
const TRUTH = `
  SELECT venue_id,
         substr(date, 1, 6)                                      AS month,
         SUM(existence = 'confirmed')                            AS files,
         SUM(CASE WHEN existence = 'confirmed'
                  THEN COALESCE(size, 0) ELSE 0 END)             AS bytes,
         SUM(existence = 'confirmed' AND downloaded_at IS NULL)  AS pending,
         SUM(CASE WHEN existence = 'confirmed' AND downloaded_at IS NULL
                  THEN COALESCE(size, 0) ELSE 0 END)             AS pending_bytes,
         SUM(existence <> 'confirmed')                           AS withdrawn
    FROM file
   GROUP BY venue_id, substr(date, 1, 6)`;

const REBUILD = `
  INSERT INTO month (venue_id, month, files, bytes, pending, pending_bytes, withdrawn)
  ${TRUTH}`;
