import { rulesFor, spansFor, venuesIn } from './rules';
import type { DatabaseSync } from 'node:sqlite';
import type { Lens, LensMember, Series } from '../types';

/**
 * What a lens lets through, as rows of `lens_series`: a series, and a span of
 * its dates — two rows where the lens cuts a hole in a series. Every view
 * through a lens reads these, so none of them evaluates rules.
 *
 * **Rebuilt whole when the lens is saved**, because any rule can move any series
 * in or out. **Extended, never rebuilt, as series arrive**: prospector numbers
 * them in order, so a lens records the newest it has looked at
 * (`series_through`) and only what is past that is evaluated — nothing, nearly
 * always, and one primary-key seek to find out.
 *
 * A series prospector deletes leaves its rows behind with no files, which lets
 * nothing through.
 */

/** Evaluate every series again, as a saved lens needs. */
export const rebuildMembers = (db: DatabaseSync, lens: Lens): void => {
  writing(db, () => {
    db.prepare('DELETE FROM lens_series WHERE lens_id = ?').run(lens.id!);
    add(db, lens, 0);
  });
};

/** Fold in the series that appeared since the lens last looked. */
export const syncMembers = (db: DatabaseSync, lens: Lens): void => {
  const through = (db.prepare('SELECT series_through AS at FROM lens WHERE id = ?').get(lens.id!) as { at: number } | undefined)?.at;
  const newest  = (db.prepare('SELECT MAX(id) AS id FROM series').get() as { id: number | null }).id ?? 0;

  if (through === undefined || newest <= through) return;

  writing(db, () => add(db, lens, through));
};

/** Forget a lens's rows, as deleting it does. */
export const dropMembers = (db: DatabaseSync, lensId: number): void => {
  db.prepare('DELETE FROM lens_series WHERE lens_id = ?').run(lensId);
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Evaluate the series past `after` against the lens and write what it lets
 * through. `lo` and `hi` are file dates, inclusive: a month bound becomes the
 * month itself from below and the month followed by `99` from above, so a file
 * dated by the month or by a day in it falls inside either way.
 */
const add = (db: DatabaseSync, lens: Lens, after: number): void => {
  const venues = new Set(venuesIn(db, lens.definition));
  const insert = db.prepare('INSERT INTO lens_series (lens_id, series_id, lo, hi) VALUES (?, ?, ?, ?)');
  const rows   = db.prepare(
    `SELECT s.id, p.venue_id AS venueId, v.name AS venue, s.symbol, s.url_symbol AS urlSymbol,
            p.market, p.dataset, p.variant, p.pattern, p.grain, s.first, s.last, p.retired_at AS retiredAt
       FROM series s JOIN pattern p ON p.id = s.pattern_id JOIN venue v ON v.id = p.venue_id
      WHERE s.id > ?
      ORDER BY s.id`,
  ).all(after) as unknown as LensMember[];

  let newest = after;

  for (const row of rows) {
    newest = Math.max(newest, row.id);

    if (! venues.has(row.venue)) continue;

    for (const span of spansFor(row as Series, rulesFor(lens.definition, row.venue)))
      insert.run(lens.id!, row.id, span.from ?? '', span.to === null ? LATEST : `${span.to}99`);
  }

  db.prepare('UPDATE lens SET series_through = ? WHERE id = ?').run(newest, lens.id!);
};

/** One transaction, so a lens is never read half written. */
const writing = (db: DatabaseSync, work: () => void): void => {
  db.exec('BEGIN IMMEDIATE');

  try {
    work();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');

    throw err;
  }
};

/** Above every file date: where a span is open-ended. */
const LATEST = '~';
