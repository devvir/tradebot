import type { DatabaseSync } from 'node:sqlite';
import type { VenueTotals } from '../types';

/**
 * The venues: one row per venue and host, which every other table keys on.
 *
 * A venue's rows are constants of the application that arrive with a
 * migration; what is asked here is which there are, the ids each answers to,
 * and what the catalog holds of each. `putVenue` writes one outside the
 * migrations, for a catalog built by hand.
 */

/**
 * Every venue the catalog holds, with where it is.
 *
 * Constants of the application rather than anything a survey wrote — they arrive
 * with the `core` migration.
 */
export const venues = (db: DatabaseSync): {
  name: string; host: string; base: string; keyRoot: string;
}[] =>
  db.prepare('SELECT name, host, base, key_root AS keyRoot FROM venue ORDER BY id').all() as unknown as {
    name: string; host: string; base: string; keyRoot: string;
  }[];

/**
 * The id of one venue's row, which every other table keys on.
 *
 * **A lookup, never a write.** The rows are constants that arrive with a
 * migration, so a name with no row is a venue this build does not have — a fault
 * worth naming rather than a row to invent.
 */
export const venueIdOf = (db: DatabaseSync, name: string, host = ''): number => {
  const found = db.prepare('SELECT id FROM venue WHERE name = ? AND host = ?')
    .get(name, host) as { id: number } | undefined;

  if (! found)
    throw new Error(`No venue row for '${name}'${host ? ` (${host})` : ''}`
      + ' — venues come from a migration, so this build does not have it');

  return found.id;
};

/**
 * Every id a venue answers to.
 *
 * A venue served by two hosts is two rows, so anything asking about the venue
 * as a whole — how much of it is catalogued, what it published in a month —
 * wants `venue_id IN (…)` rather than a single id. One host is the ordinary
 * case and returns one id, so callers need no special path for it.
 */
export const venueIds = (db: DatabaseSync, name: string): number[] =>
  (db.prepare('SELECT id FROM venue WHERE name = ? ORDER BY host').all(name) as { id: number }[])
    .map(row => row.id);

/**
 * Every venue there is anything to say about, with its totals.
 *
 * Summed from its partitions rather than cached again: a venue is a few
 * thousand of them, so this is quick, and a second cache would be a second thing
 * that can disagree with the first. `firstMonth` and `lastMonth` fall out of the
 * same rows, which is why they need no column of their own.
 *
 * A venue served by two hosts is one row here: a slice is the venue's, whichever
 * server publishes it.
 */
export const venueTotals = (db: DatabaseSync): VenueTotals[] =>
  db.prepare(
    `SELECT v.name                                    AS venue,
            MIN(CASE WHEN m.files > 0 THEN m.month END) AS firstMonth,
            MAX(CASE WHEN m.files > 0 THEN m.month END) AS lastMonth,
            COALESCE(SUM(m.files), 0)                 AS files,
            COALESCE(SUM(m.bytes), 0)                 AS bytes,
            COALESCE(SUM(m.pending), 0)               AS pending,
            COALESCE(SUM(m.pending_bytes), 0)         AS pendingBytes,
            COALESCE(SUM(m.withdrawn), 0)             AS withdrawn
       FROM (SELECT DISTINCT name FROM venue) v
       LEFT JOIN slice c     ON c.venue = v.name
       LEFT JOIN partition m ON m.slice_id = c.id
      GROUP BY v.name
      ORDER BY v.name`,
  ).all() as unknown as VenueTotals[];

/**
 * Register a venue, or update where it is served from. Returns its id.
 *
 * **A fixture, not a path of the service.** A catalog's venues are the ones its
 * migrations seed; this writes one outside them, for a catalog built by hand.
 */
export const putVenue = (
  db:   DatabaseSync,
  name: string,
  base: string,
  keyRoot: string,
  host: string = '',
): number => {
  db.prepare(
    `INSERT INTO venue (name, host, base, key_root) VALUES (?, ?, ?, ?)
       ON CONFLICT (name, host) DO UPDATE SET base = excluded.base, key_root = excluded.key_root`,
  ).run(name, host, base, keyRoot);

  const row = db.prepare('SELECT id FROM venue WHERE name = ? AND host = ?')
    .get(name, host) as { id: number };

  return row.id;
};
