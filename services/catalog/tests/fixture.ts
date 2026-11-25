import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { emptyCatalog } from '@tradebot/prospector/testing';
import { catchUp, editLens, lensNamed, putLens } from '@tradebot/lenses';
import type { Lens, LensDefinition, LensWrite } from '@tradebot/lenses';
import type { FileSpec, Scratch, SeriesSpec } from './types';

/**
 * A scratch catalog for the tests: prospector's own schema, created empty and
 * opened as prospector opens it — write-ahead log, foreign keys on — and the
 * few writes a test needs to fill it, the way prospector writes them,
 * partitions included, since every size and month is read off those.
 *
 * The schema is prospector's own, from the test entry it exports, rather than
 * a copy, so the planner sees the tables, types and indexes it sees in
 * production. The real database is prospector's, and nothing in these tests
 * ever opens it.
 */

/** An empty catalog at this path, as prospector creates one. */
export const openScratch = (path: string): DatabaseSync => emptyCatalog(path);

/** An empty catalog in a directory of its own, and how to throw it away. */
export const scratch = (): Scratch => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-'));
  const db  = openScratch(join(dir, 'catalog.db'));

  return { db, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
};

/**
 * A lens as it stands once prospector has stored it and worked out what it
 * lets through — which in the service is two moments, and here is one.
 */
export const storeLens = (db: DatabaseSync, slug: string, name = '', note = '', definition?: LensDefinition): Lens | null =>
  (putLens(db, slug, name, note, definition) ? worked(db, slug) : null);

/** The same, for a lens replaced. */
export const changeLens = (db: DatabaseSync, slug: string, to: LensWrite): Lens | null => {
  const saved = editLens(db, slug, to);

  return saved ? worked(db, saved.slug) : null;
};

/** Have a lens's partitions worked out to the newest there is, as prospector does in the background. */
export const worked = (db: DatabaseSync, slug: string): Lens | null => {
  const lens = lensNamed(db, slug);

  if (lens) while (catchUp(db, lens, 1_000));

  return lensNamed(db, slug);
};

/** One host of a venue. */
export const putVenue = (db: DatabaseSync, name: string, base: string, keyRoot = '', host = ''): number =>
  Number(db.prepare('INSERT INTO venue (name, host, base, key_root) VALUES (?, ?, ?, ?)')
    .run(name, host, base, keyRoot).lastInsertRowid);

/** A venue's first host, by name. */
export const venueIdOf = (db: DatabaseSync, name: string): number =>
  (db.prepare('SELECT id FROM venue WHERE name = ? ORDER BY host').get(name) as { id: number }).id;

/**
 * A series under its pattern, the pattern and its slice created where they are
 * new. The grain is read off the pattern's finest calendar slot and the bundle
 * off the symbol, as prospector reads them.
 */
export const recordSeries = (
  db:      DatabaseSync,
  venueId: number,
  spec:    SeriesSpec,
  bounds:  { first?: string; last?: string } = {},
): { id: number } => {
  const variant = spec.variant ?? '';
  const grain   = spec.pattern.includes('{MI}') ? 'minutely' : spec.pattern.includes('{HH}') ? 'hourly'
    : spec.pattern.includes('{DD}') ? 'daily' : 'monthly';

  const slice = db.prepare(
    `INSERT INTO slice (venue, market, dataset, variant, grain, bundle)
     SELECT name, ?, ?, ?, ?, ? FROM venue WHERE id = ?
         ON CONFLICT (venue, market, dataset, variant, grain, bundle) DO UPDATE SET venue = excluded.venue
     RETURNING id`,
  ).get(spec.market, spec.dataset, variant, grain, spec.symbol === '@' ? 'market' : 'instrument', venueId) as { id: number };

  db.prepare(
    'INSERT OR IGNORE INTO pattern (venue_id, slice_id, pattern, retired_at) VALUES (?, ?, ?, ?)',
  ).run(venueId, slice.id, spec.pattern, spec.retiredAt ?? null);

  const pattern = db.prepare(
    'SELECT id FROM pattern WHERE venue_id = ? AND slice_id = ? AND pattern = ?',
  ).get(venueId, slice.id, spec.pattern) as { id: number };

  /** A venue-wide bucket holds every instrument of a market, and so has none. */
  const instrument = spec.symbol === '@' ? null : (db.prepare(
    `INSERT INTO instrument (venue, market, symbol)
     SELECT name, ?, ? FROM venue WHERE id = ?
         ON CONFLICT (venue, market, symbol) DO UPDATE SET symbol = excluded.symbol
     RETURNING id`,
  ).get(spec.market, spec.symbol, venueId) as { id: number }).id;

  return { id: Number(db.prepare(
    'INSERT INTO series (pattern_id, instrument_id, url_symbol, first, last) VALUES (?, ?, ?, ?, ?)',
  ).run(pattern.id, instrument, spec.urlSymbol ?? null, bounds.first ?? null, bounds.last ?? null).lastInsertRowid) };
};

/**
 * Files, each in its partition — created where it is new — and counted into it
 * as prospector counts them where confirmed; each series' bounds follow.
 */
export const putFiles = async (db: DatabaseSync, files: readonly FileSpec[]): Promise<void> => {
  const insert = db.prepare(
    `INSERT INTO file (venue_id, path, date, size, etag, modified, series_id, partition_id, existence, seen_at,
                       downloaded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'T0', NULL)`,
  );

  for (const one of files) {
    const existence = one.existence ?? 'confirmed';
    const partition = partitionOf(db, one);

    insert.run(one.venueId, one.path, one.date, one.size ?? 10, one.etag ?? 'e', one.modified ?? null,
      one.seriesId, partition, existence);

    if (existence === 'confirmed') tally(db, partition, one);
  }

  db.exec(`UPDATE series SET
             first = (SELECT MIN(date) FROM file WHERE series_id = series.id),
             last  = (SELECT MAX(date) FROM file WHERE series_id = series.id)
           WHERE EXISTS (SELECT 1 FROM file WHERE series_id = series.id)`);
};

/** Mark files downloaded, by path, moving them out of pending in their partitions. */
export const markDownloaded = (db: DatabaseSync, files: readonly { venueId: number; path: string }[], at = 'T1'): void => {
  for (const { venueId, path } of files) {
    const row = db.prepare(
      'SELECT series_id AS seriesId, date, size, downloaded_at AS at FROM file WHERE venue_id = ? AND path = ?',
    ).get(venueId, path) as { seriesId: number; date: string; size: number; at: string | null } | undefined;

    if (! row || row.at !== null) continue;

    db.prepare('UPDATE file SET downloaded_at = ? WHERE venue_id = ? AND path = ?').run(at, venueId, path);

    db.prepare(
      `UPDATE partition SET pending = pending - 1, pending_bytes = pending_bytes - ?
        WHERE month = ? AND slice_id = (${SLICE_OF_SERIES})`,
    ).run(row.size, row.date.slice(0, 6), row.seriesId);
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** The slice a series' pattern publishes into, by the series' id. */
const SLICE_OF_SERIES = 'SELECT p.slice_id FROM series s JOIN pattern p ON p.id = s.pattern_id WHERE s.id = ?';

/** A file's partition — its series' slice, at the month of its date — created empty where it is new. */
const partitionOf = (db: DatabaseSync, one: FileSpec): number =>
  (db.prepare(
    `INSERT INTO partition (slice_id, month, updated_at) VALUES ((${SLICE_OF_SERIES}), ?, ?)
         -- A self-assignment, so the row is untouched and RETURNING still yields it.
         ON CONFLICT (slice_id, month) DO UPDATE SET month = excluded.month
     RETURNING id`,
  ).get(one.seriesId, one.date.slice(0, 6), one.seenAt ?? 'T0') as { id: number }).id;

/**
 * One confirmed file counted into its partition. The version is not
 * prospector's sum here — only that it moves is read.
 */
const tally = (db: DatabaseSync, partition: number, one: FileSpec): void => {
  const size = one.size ?? 10;

  db.prepare(
    `UPDATE partition SET
       files = files + 1, bytes = bytes + ?1, pending = pending + 1, pending_bytes = pending_bytes + ?1,
       version = printf('%016x', files + 1), updated_at = ?2
     WHERE id = ?3`,
  ).run(size, one.seenAt ?? 'T0', partition);
};
