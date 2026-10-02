import type { DatabaseSync } from 'node:sqlite';
import type { FileEffect, MonthDelta, SeriesMonthDelta } from '../../types';

/**
 * The rollups: per venue and month in `rollup_venue`, per series and month in
 * `rollup_series` — how many files, how large, how many still to download, how
 * many the venue has withdrawn.
 *
 * **Why a cache at all.** Every one of those is an aggregate over `file`, which
 * is tens of gigabytes, so asking directly is not a slow query but an outage —
 * and they are the most ordinary questions anyone has. A limit does not rescue
 * them either: "is there anything left for this venue" still reads a million
 * rows to answer *no*.
 *
 * **Two grains, kept by one path.** `rollup_venue` answers the constant
 * questions — every venue's totals, which months hold work — from a few hundred
 * rows, which is what a page polling every few seconds can afford.
 * `rollup_series` answers anything narrower than a venue, a lens above all,
 * from a few million: exact at any selection, without reading a file. Both move
 * from the same effects in the same transaction, so they cannot disagree with
 * each other any more than with the rows.
 *
 * **Why only these.** A cache is not free — it is one more thing to keep
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
 * What a batch of writes does to the series rollup — `deltasOf` at the grain of
 * one series. A file that moved between series is subtracted from one and added
 * to the other, as a month move is.
 */
export const seriesDeltasOf = (effects: readonly FileEffect[]): SeriesMonthDelta[] => {
  const byKey = new Map<string, SeriesMonthDelta>();

  const at = (seriesId: number, month: string): SeriesMonthDelta => {
    const key   = `${seriesId}|${month}`;
    const found = byKey.get(key)
      ?? { seriesId, month, files: 0, bytes: 0, pending: 0, pendingBytes: 0, withdrawn: 0 };

    byKey.set(key, found);

    return found;
  };

  for (const { was, now } of effects) {
    if (was) count(at(was.seriesId, was.month), was, -1);

    count(at(now.seriesId, now.month), now, 1);
  }

  return [...byKey.values()].filter(moves);
};

/**
 * Record a batch of writes in both rollups.
 *
 * **The caller's transaction is the point.** This never opens one of its own, so
 * the counters move with the rows they describe or not at all.
 */
export const record = (db: DatabaseSync, effects: readonly FileEffect[]): void => {
  apply(db, deltasOf(effects));
  applySeries(db, seriesDeltasOf(effects));
};

/**
 * Apply deltas to the venue rollup.
 *
 * **The caller's transaction is the point.** This never opens one of its own, so
 * the counters move with the rows they describe or not at all — a cache updated
 * in a transaction of its own is a cache that is wrong whenever the two disagree,
 * and nothing would notice.
 */
export const apply = (db: DatabaseSync, deltas: readonly MonthDelta[]): void => {
  if (deltas.length === 0) return;

  const upsert = db.prepare(
    `INSERT INTO rollup_venue (venue_id, month, files, bytes, pending, pending_bytes, withdrawn)
          VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue_id, month) DO UPDATE SET
          files         = rollup_venue.files         + excluded.files,
          bytes         = rollup_venue.bytes         + excluded.bytes,
          pending       = rollup_venue.pending       + excluded.pending,
          pending_bytes = rollup_venue.pending_bytes + excluded.pending_bytes,
          withdrawn     = rollup_venue.withdrawn     + excluded.withdrawn`,
  );

  for (const d of deltas)
    upsert.run(d.venueId, d.month, d.files, d.bytes, d.pending, d.pendingBytes, d.withdrawn);
};

/** Apply deltas to the series rollup, as `apply` does to the venue one. */
export const applySeries = (db: DatabaseSync, deltas: readonly SeriesMonthDelta[]): void => {
  if (deltas.length === 0) return;

  const upsert = db.prepare(
    `INSERT INTO rollup_series (series_id, month, files, bytes, pending, pending_bytes, withdrawn)
          VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (series_id, month) DO UPDATE SET
          files         = rollup_series.files         + excluded.files,
          bytes         = rollup_series.bytes         + excluded.bytes,
          pending       = rollup_series.pending       + excluded.pending,
          pending_bytes = rollup_series.pending_bytes + excluded.pending_bytes,
          withdrawn     = rollup_series.withdrawn     + excluded.withdrawn`,
  );

  for (const d of deltas)
    upsert.run(d.seriesId, d.month, d.files, d.bytes, d.pending, d.pendingBytes, d.withdrawn);
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Add one file state into a series cell, or take it out (`sign` -1). */
const count = (cell: SeriesMonthDelta, state: FileEffect['now'], sign: 1 | -1): void => {
  if (! state.confirmed) {
    cell.withdrawn += sign;

    return;
  }

  cell.files += sign;
  cell.bytes += sign * state.bytes;

  if (! state.downloaded) {
    cell.pending      += sign;
    cell.pendingBytes += sign * state.bytes;
  }
};

/** Whether a delta says anything. */
const moves = (d: MonthDelta | SeriesMonthDelta): boolean =>
  d.files !== 0 || d.bytes !== 0 || d.pending !== 0 || d.pendingBytes !== 0 || d.withdrawn !== 0;
