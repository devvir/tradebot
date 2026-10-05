import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FileSpec, Scratch, SeriesSpec } from './types';

/**
 * A scratch catalog for the tests: the tables this service reads, created
 * empty, and the few writes a test needs to fill them — the way prospector
 * writes them, partitions included, since every size and month is read off those.
 *
 * Only the columns and keys the catalog reads are here. The real database is
 * prospector's, and nothing in these tests ever opens it.
 */

/** An empty catalog at this path, with the tables the catalog reads. */
export const openScratch = (path: string): DatabaseSync => {
  const db = new DatabaseSync(path);

  db.exec(SCHEMA);

  return db;
};

/** An empty catalog in a directory of its own, and how to throw it away. */
export const scratch = (): Scratch => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-'));
  const db  = new DatabaseSync(join(dir, 'catalog.db'));

  db.exec(SCHEMA);

  return { db, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
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

/** Files, counted into their partitions as prospector counts them; each series' bounds follow. */
export const putFiles = async (db: DatabaseSync, files: readonly FileSpec[]): Promise<void> => {
  const insert = db.prepare(
    `INSERT INTO file (venue_id, path, date, size, etag, modified, series_id, existence, seen_at, downloaded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'T0', NULL)`,
  );

  for (const one of files) {
    const existence = one.existence ?? 'confirmed';

    insert.run(one.venueId, one.path, one.date, one.size ?? 10, one.etag ?? 'e', one.modified ?? null,
      one.seriesId, existence);

    if (existence === 'confirmed') tally(db, one);
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

/**
 * One confirmed file into its partition: its series' slice, at the month of its
 * date. The version is not prospector's sum here — only that it moves is read.
 */
const tally = (db: DatabaseSync, one: FileSpec): void => {
  const size = one.size ?? 10;

  db.prepare(
    `INSERT INTO partition (slice_id, month, files, bytes, pending, pending_bytes, version, updated_at)
          VALUES ((${SLICE_OF_SERIES}), ?, 1, ?, 1, ?, '0000000000000001', ?)
       ON CONFLICT (slice_id, month) DO UPDATE SET
         files = files + 1, bytes = bytes + excluded.bytes,
         pending = pending + 1, pending_bytes = pending_bytes + excluded.pending_bytes,
         version = printf('%016x', files + 1), updated_at = excluded.updated_at`,
  ).run(one.seriesId, one.date.slice(0, 6), size, size, one.seenAt ?? 'T0');
};

const SCHEMA = `
  CREATE TABLE venue (id INTEGER PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL DEFAULT '',
    base TEXT NOT NULL, key_root TEXT NOT NULL, UNIQUE (name, host));
  CREATE TABLE slice (id INTEGER PRIMARY KEY, venue TEXT NOT NULL, market TEXT NOT NULL, dataset TEXT NOT NULL,
    variant TEXT NOT NULL DEFAULT '', grain TEXT NOT NULL, bundle TEXT NOT NULL,
    UNIQUE (venue, market, dataset, variant, grain, bundle));
  CREATE TABLE partition (id INTEGER PRIMARY KEY, slice_id INTEGER NOT NULL, month TEXT NOT NULL,
    files INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0,
    pending_bytes INTEGER NOT NULL DEFAULT 0, withdrawn INTEGER NOT NULL DEFAULT 0,
    version TEXT NOT NULL DEFAULT '0000000000000000', updated_at TEXT NOT NULL, UNIQUE (slice_id, month));
  CREATE TABLE pattern (id INTEGER PRIMARY KEY, venue_id INTEGER NOT NULL, slice_id INTEGER NOT NULL,
    pattern TEXT NOT NULL, retired_at TEXT, UNIQUE (venue_id, slice_id, pattern));
  CREATE TABLE instrument (id INTEGER PRIMARY KEY, venue TEXT NOT NULL, market TEXT NOT NULL,
    symbol TEXT NOT NULL, UNIQUE (venue, market, symbol));
  CREATE TABLE series (id INTEGER PRIMARY KEY, pattern_id INTEGER NOT NULL, instrument_id INTEGER,
    url_symbol TEXT, first TEXT, last TEXT, prefix TEXT);
  CREATE INDEX series_prefix ON series (prefix);
  CREATE TRIGGER series_prefix AFTER INSERT ON series BEGIN
    UPDATE series SET prefix = (
      SELECT CASE WHEN i.symbol = '' OR instr(i.symbol, '/') > 0 THEN NULL ELSE
               c.venue || '/' || c.market || '/' || c.dataset
               || CASE WHEN c.variant <> '' THEN ',' || c.variant ELSE '' END
               || '/' || CASE WHEN i.id IS NULL THEN '@/' ELSE
                    CASE WHEN upper(substr(i.symbol, 1, 1)) GLOB '[A-Z]'
                         THEN upper(substr(i.symbol, 1, 1)) ELSE '_' END
                    || '/' || i.symbol || '/' END END
        FROM pattern p JOIN slice c ON c.id = p.slice_id
        LEFT JOIN instrument i ON i.id = NEW.instrument_id WHERE p.id = NEW.pattern_id)
    WHERE id = NEW.id;
  END;
  CREATE TABLE file (venue_id INTEGER NOT NULL, path TEXT NOT NULL, date TEXT NOT NULL, size INTEGER,
    etag TEXT, modified TEXT, series_id INTEGER NOT NULL, existence TEXT NOT NULL, seen_at TEXT NOT NULL,
    downloaded_at TEXT, PRIMARY KEY (venue_id, path));
  CREATE INDEX file_series ON file (series_id, date, existence);
  CREATE INDEX file_pending ON file (series_id, date) WHERE downloaded_at IS NULL AND existence = 'confirmed';
  CREATE TABLE lens (id INTEGER PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '', definition TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    partitions_through INTEGER NOT NULL DEFAULT 0);
  CREATE UNIQUE INDEX lens_slug ON lens (slug);
  CREATE TABLE lens_member (lens_id INTEGER NOT NULL, partition_id INTEGER NOT NULL,
    PRIMARY KEY (lens_id, partition_id)) WITHOUT ROWID;
  CREATE TABLE run (id INTEGER PRIMARY KEY, venue_id INTEGER NOT NULL, kind TEXT NOT NULL, scope TEXT NOT NULL,
    started TEXT NOT NULL, completed TEXT);
`;
