import type { DatabaseSync } from 'node:sqlite';
import type { Unreadable } from '../types';

/**
 * Paths a venue served that no adapter could read into a series: the worklist
 * of shapes nothing accounts for, and how much of the archive each covers.
 */

/**
 * Record paths a venue served that no adapter could read into a series.
 *
 * **An upsert keyed by path**, so a shape met again on the next pass raises a
 * count rather than filling the table: what matters when this is read is how
 * many distinct shapes are unaccounted for, and how much of the archive each one
 * covers.
 */
export const putUnreadable = (
  db:      DatabaseSync,
  venueId: number,
  paths:   readonly { path: string; reason: Unreadable['reason'] }[],
): void => {
  if (paths.length === 0) return;

  const at   = new Date().toISOString();
  const save = db.prepare(
    `INSERT INTO unreadable (venue_id, path, reason, seen, first_seen, last_seen)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT (venue_id, path) DO UPDATE
        SET seen = seen + 1, last_seen = excluded.last_seen, reason = excluded.reason`,
  );

  for (const one of paths) save.run(venueId, one.path, one.reason, at, at);
};

/** The worklist for one venue, or for every venue when none is named. */
export const unreadable = (db: DatabaseSync, venueId?: number): Unreadable[] =>
  db.prepare(
    `SELECT v.name AS venue, v.host, u.path, u.reason, u.seen,
            u.first_seen AS firstSeen, u.last_seen AS lastSeen
       FROM unreadable u JOIN venue v ON v.id = u.venue_id
      ${venueId === undefined ? '' : 'WHERE u.venue_id = ?'}
      ORDER BY u.seen DESC, u.path`,
  ).all(...(venueId === undefined ? [] : [venueId])) as unknown as Unreadable[];
