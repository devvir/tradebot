import { logger } from '@devvir/service-kit';
import { GLOBAL, rulesFor, spansFor, venuesIn } from './rules';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Lens, LensDefinition, LensMember, Series } from '../types';

/**
 * What a lens lets through, as rows of `lens_series`: a series, and a span of
 * its dates — two rows where an exclude cuts a hole in a series. Every view
 * through a lens reads these, so none of them evaluates rules.
 *
 * **Rebuilt when the lens is saved, for the venues the save changed**: a change
 * to one venue's rules can only move that venue's series, while a change to the
 * global rules (`*`) can move any. **Extended, never rebuilt, as series
 * arrive**: prospector numbers them in order, so a lens records the newest it
 * has looked at (`series_through`) and only what is past that is evaluated.
 *
 * **Kept current in the background** (`keepCurrent`), a slice at a time, so a
 * request through a lens rarely finds anything to add — and a request that does
 * still adds it first (`syncMembers`), so a lens is never behind the catalog.
 *
 * A series prospector deletes leaves its rows behind with no files, which lets
 * nothing through.
 */

/**
 * Evaluate a saved lens again: every venue where `was` is not given, and
 * otherwise only the venues whose rules differ from `was`.
 */
export const rebuildMembers = (db: DatabaseSync, lens: Lens, was?: LensDefinition): void => {
  const venues = was ? changedVenues(db, was, lens.definition) : null;

  if (venues && venues.length === 0) return;

  writing(db, () => {
    if (venues) {
      db.prepare(
        `DELETE FROM lens_series WHERE lens_id = ? AND series_id IN (
           SELECT s.id FROM venue v JOIN pattern p ON p.venue_id = v.id JOIN series s ON s.pattern_id = p.id
            WHERE v.name IN (SELECT value FROM json_each(?)))`,
      ).run(lens.id!, JSON.stringify(venues));

      // Up to where the lens has read: anything newer is added by catching up, as for any lens.
      add(db, lens, 0, throughOf(db, lens), venues.filter(one => venuesIn(db, lens.definition).includes(one)));

      return;
    }

    const newest = newestSeries(db);

    db.prepare('DELETE FROM lens_series WHERE lens_id = ?').run(lens.id!);
    add(db, lens, 0, newest, venuesIn(db, lens.definition));
    db.prepare('UPDATE lens SET series_through = ? WHERE id = ?').run(newest, lens.id!);
  });
};

/** Fold in every series that appeared since the lens last looked, at once. */
export const syncMembers = (db: DatabaseSync, lens: Lens): void => {
  while (catchUp(db, lens, Infinity));
};

/** Forget a lens's rows, as deleting it does. */
export const dropMembers = (db: DatabaseSync, lensId: number): void => {
  db.prepare('DELETE FROM lens_series WHERE lens_id = ?').run(lensId);
};

/**
 * Keep every lens current in the background: now, and every `EVERY_MS`, fold in
 * the series that appeared since, `SLICE` at a time and yielding between slices,
 * so a large arrival — a venue's first walk creates series by the hundred
 * thousand — never holds a request up for longer than one slice.
 */
export const keepCurrent = (db: DatabaseSync, lenses: () => Lens[]): (() => void) => {
  let running = false;

  const round = async (): Promise<void> => {
    if (running) return;

    running = true;

    try {
      for (const lens of lenses())
        while (catchUp(db, lens, SLICE)) await new Promise(done => setImmediate(done));
    } catch (err) {
      logger.warn({ err }, 'Could not bring the lenses up to date — trying again later');
    } finally {
      running = false;
    }
  };

  void round();

  const timer = setInterval(() => void round(), EVERY_MS);

  return () => clearInterval(timer);
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** How often the lenses are brought up to date in the background. */
const EVERY_MS = 15 * 60_000;

/** Series evaluated per background step, between which requests are answered. */
const SLICE = 5_000;

/** Above every file date: where a span is open-ended. */
const LATEST = '~';

/**
 * Add the series past where the lens has read, up to `most` of them. Says
 * whether more remain. Each step is one transaction, and `series_through`
 * moves with it, so a restart or a crash resumes where it stopped.
 */
const catchUp = (db: DatabaseSync, lens: Lens, most: number): boolean => {
  const through = throughOf(db, lens);
  const newest  = newestSeries(db);

  if (through >= newest) return false;

  const upto = Math.min(newest, through + most);

  writing(db, () => {
    add(db, lens, through, upto, venuesIn(db, lens.definition));
    db.prepare('UPDATE lens SET series_through = ? WHERE id = ?').run(upto, lens.id!);
  });

  return upto < newest;
};

/**
 * Evaluate the series in `(after, upto]` of these venues against the lens, and
 * write what it lets through. `lo` and `hi` are file dates, inclusive: a month
 * bound becomes the month itself from below and the month followed by `99` from
 * above, so a file dated by the month or by a day in it falls inside either way.
 *
 * **Only the series of the venues named are read**, and a lens naming none
 * reads nothing.
 */
const add = (db: DatabaseSync, lens: Lens, after: number, upto: number, venues: readonly string[]): void => {
  if (venues.length === 0 || upto <= after) return;

  const insert = db.prepare('INSERT INTO lens_series (lens_id, series_id, lo, hi) VALUES (?, ?, ?, ?)');
  const rows   = statementsOf(db)[upto - after <= SLICE ? 'byId' : 'byVenue']
    .all(JSON.stringify(venues), after, upto) as unknown as LensMember[];

  for (const row of rows)
    for (const span of spansFor(row as Series, rulesFor(lens.definition, row.venue)))
      insert.run(lens.id!, row.id, span.from ?? '', span.to === null ? LATEST : `${span.to}99`);
};

/**
 * Two ways to read the same rows. **By venue** for a rebuild, which wants every
 * series of the venues: pattern by pattern, never touching another venue's.
 * **By id** for catching up, which wants a narrow range of new ones: the series
 * key over that range alone. `CROSS JOIN` fixes each order, since SQLite never
 * reorders one.
 */
const statementsOf = (db: DatabaseSync): { byVenue: StatementSync; byId: StatementSync } => {
  let held = PREPARED.get(db);

  if (! held) {
    const columns = `s.id, p.venue_id AS venueId, v.name AS venue, s.symbol, s.url_symbol AS urlSymbol,
                     p.market, p.dataset, p.variant, p.pattern, p.grain, s.first, s.last, p.retired_at AS retiredAt`;

    held = {
      byVenue: db.prepare(
        `SELECT ${columns}
           FROM venue v CROSS JOIN pattern p ON p.venue_id = v.id CROSS JOIN series s ON s.pattern_id = p.id
          WHERE v.name IN (SELECT value FROM json_each(?)) AND s.id > ? AND s.id <= ?`),
      byId: db.prepare(
        `SELECT ${columns}
           FROM series s CROSS JOIN pattern p ON p.id = s.pattern_id CROSS JOIN venue v ON v.id = p.venue_id
          WHERE v.name IN (SELECT value FROM json_each(?)) AND s.id > ? AND s.id <= ?`),
    };

    PREPARED.set(db, held);
  }

  return held;
};

const PREPARED = new WeakMap<DatabaseSync, { byVenue: StatementSync; byId: StatementSync }>();

/**
 * The venues whose rules differ between two definitions — every venue either
 * names where the global rules differ, since those reach them all.
 */
const changedVenues = (db: DatabaseSync, was: LensDefinition, now: LensDefinition): string[] => {
  const same = (venue: string) =>
    JSON.stringify(was.venues?.[venue] ?? []) === JSON.stringify(now.venues?.[venue] ?? []);

  if (! same(GLOBAL)) return [...new Set([...venuesIn(db, was), ...venuesIn(db, now)])];

  const named = new Set([...Object.keys(was.venues ?? {}), ...Object.keys(now.venues ?? {})]);

  return [...named].filter(venue => venue !== GLOBAL && ! same(venue));
};

const throughOf = (db: DatabaseSync, lens: Lens): number =>
  (db.prepare('SELECT series_through AS at FROM lens WHERE id = ?').get(lens.id!) as { at: number } | undefined)?.at ?? 0;

const newestSeries = (db: DatabaseSync): number =>
  (db.prepare('SELECT MAX(id) AS id FROM series').get() as { id: number | null }).id ?? 0;

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
