import type { DatabaseSync } from 'node:sqlite';

/**
 * The files a venue serves that are not historical data, which a walk refuses
 * by path.
 */

/**
 * Every file this venue serves that is not historical data.
 *
 * The paths alone, which is all a walk needs to refuse one.
 */
export const exclusionsFor = (db: DatabaseSync, venueId: number): string[] =>
  (db.prepare('SELECT path FROM exclusion WHERE venue_id = ?')
    .all(venueId) as unknown as { path: string }[]).map(row => row.path);
