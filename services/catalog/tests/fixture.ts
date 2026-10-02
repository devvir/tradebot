import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FileSpec, Scratch, SeriesSpec } from './types';

/**
 * A scratch catalog for the tests: the tables this service reads, created
 * empty, and the few writes a test needs to fill them — the way prospector
 * writes them, rollups included, since every size and month is read off those.
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
 * A series under its pattern, the pattern created where it is new. The grain is
 * read off the pattern's finest calendar slot, as prospector reads it.
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

  db.prepare(
    `INSERT OR IGNORE INTO pattern (venue_id, market, dataset, variant, pattern, grain, retired_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(venueId, spec.market, spec.dataset, variant, spec.pattern, grain, spec.retiredAt ?? null);

  const pattern = db.prepare(
    'SELECT id FROM pattern WHERE venue_id = ? AND market = ? AND dataset = ? AND pattern = ?',
  ).get(venueId, spec.market, spec.dataset, spec.pattern) as { id: number };

  return { id: Number(db.prepare(
    'INSERT INTO series (pattern_id, symbol, url_symbol, first, last) VALUES (?, ?, ?, ?, ?)',
  ).run(pattern.id, spec.symbol, spec.urlSymbol ?? null, bounds.first ?? null, bounds.last ?? null).lastInsertRowid) };
};

/** Files, counted into both rollups as prospector counts them; each series' bounds follow. */
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

/** Mark files downloaded, by path, moving them out of pending in both rollups. */
export const markDownloaded = (db: DatabaseSync, files: readonly { venueId: number; path: string }[], at = 'T1'): void => {
  for (const { venueId, path } of files) {
    const row = db.prepare(
      'SELECT series_id AS seriesId, date, size, downloaded_at AS at FROM file WHERE venue_id = ? AND path = ?',
    ).get(venueId, path) as { seriesId: number; date: string; size: number; at: string | null } | undefined;

    if (! row || row.at !== null) continue;

    db.prepare('UPDATE file SET downloaded_at = ? WHERE venue_id = ? AND path = ?').run(at, venueId, path);

    for (const [table, key, id] of [['rollup_venue', 'venue_id', venueId], ['rollup_series', 'series_id', row.seriesId]] as const)
      db.prepare(`UPDATE ${table} SET pending = pending - 1, pending_bytes = pending_bytes - ? WHERE ${key} = ? AND month = ?`)
        .run(row.size, id, row.date.slice(0, 6));
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

const tally = (db: DatabaseSync, one: FileSpec): void => {
  const size = one.size ?? 10;

  for (const [table, key, id] of [['rollup_venue', 'venue_id', one.venueId], ['rollup_series', 'series_id', one.seriesId]] as const)
    db.prepare(
      `INSERT INTO ${table} (${key}, month, files, bytes, pending, pending_bytes) VALUES (?, ?, 1, ?, 1, ?)
         ON CONFLICT (${key}, month) DO UPDATE SET
           files = files + 1, bytes = bytes + excluded.bytes,
           pending = pending + 1, pending_bytes = pending_bytes + excluded.pending_bytes`,
    ).run(id, one.date.slice(0, 6), size, size);
};

const SCHEMA = `
  CREATE TABLE venue (id INTEGER PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL DEFAULT '',
    base TEXT NOT NULL, key_root TEXT NOT NULL, UNIQUE (name, host));
  CREATE TABLE pattern (id INTEGER PRIMARY KEY, venue_id INTEGER NOT NULL, market TEXT NOT NULL,
    dataset TEXT NOT NULL, variant TEXT NOT NULL DEFAULT '', pattern TEXT NOT NULL,
    grain TEXT NOT NULL DEFAULT 'monthly', retired_at TEXT, UNIQUE (venue_id, market, dataset, pattern));
  CREATE TABLE series (id INTEGER PRIMARY KEY, pattern_id INTEGER NOT NULL, symbol TEXT NOT NULL DEFAULT '',
    url_symbol TEXT, first TEXT, last TEXT, prefix TEXT);
  CREATE INDEX series_prefix ON series (prefix);
  CREATE TRIGGER series_prefix AFTER INSERT ON series BEGIN
    UPDATE series SET prefix = (
      SELECT CASE WHEN NEW.symbol = '' OR instr(NEW.symbol, '/') > 0 THEN NULL ELSE
               v.name || '/' || p.market || '/' || p.dataset
               || CASE WHEN p.variant <> '' THEN ',' || p.variant ELSE '' END
               || '/' || CASE WHEN NEW.symbol = '@' THEN '@/' ELSE
                    CASE WHEN upper(substr(NEW.symbol, 1, 1)) GLOB '[A-Z]'
                         THEN upper(substr(NEW.symbol, 1, 1)) ELSE '_' END
                    || '/' || NEW.symbol || '/' END END
        FROM pattern p JOIN venue v ON v.id = p.venue_id WHERE p.id = NEW.pattern_id)
    WHERE id = NEW.id;
  END;
  CREATE TABLE file (venue_id INTEGER NOT NULL, path TEXT NOT NULL, date TEXT NOT NULL, size INTEGER,
    etag TEXT, modified TEXT, series_id INTEGER NOT NULL, existence TEXT NOT NULL, seen_at TEXT NOT NULL,
    downloaded_at TEXT, PRIMARY KEY (venue_id, path));
  CREATE INDEX file_series ON file (series_id, date, existence);
  CREATE INDEX file_pending ON file (series_id, date) WHERE downloaded_at IS NULL AND existence = 'confirmed';
  CREATE TABLE rollup_venue (venue_id INTEGER NOT NULL, month TEXT NOT NULL, files INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0, pending_bytes INTEGER NOT NULL DEFAULT 0,
    withdrawn INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (venue_id, month));
  CREATE TABLE rollup_series (series_id INTEGER NOT NULL, month TEXT NOT NULL, files INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0, pending_bytes INTEGER NOT NULL DEFAULT 0,
    withdrawn INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (series_id, month));
  CREATE TABLE lens (id INTEGER PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '', definition TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    series_through INTEGER NOT NULL DEFAULT 0);
  CREATE UNIQUE INDEX lens_slug ON lens (slug);
  CREATE TABLE lens_series (lens_id INTEGER NOT NULL, series_id INTEGER NOT NULL, lo TEXT NOT NULL, hi TEXT NOT NULL);
  CREATE INDEX lens_series_key ON lens_series (lens_id, series_id, lo);
`;
