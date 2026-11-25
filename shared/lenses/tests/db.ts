import { DatabaseSync } from 'node:sqlite';

/**
 * An empty in-memory database with the tables a lens is read, stored and
 * evaluated against, and foreign keys on: `venue` and its names, `slice` and
 * `partition`, `lens` with its unique slug and `lens_member`.
 */
export const scratch = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');

  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE venue (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;

    CREATE TABLE slice (
      id      INTEGER PRIMARY KEY,
      venue   TEXT NOT NULL,
      market  TEXT NOT NULL,
      dataset TEXT NOT NULL,
      variant TEXT NOT NULL DEFAULT '',
      grain   TEXT NOT NULL,
      bundle  TEXT NOT NULL
    ) STRICT;

    CREATE TABLE partition (
      id            INTEGER PRIMARY KEY,
      slice_id      INTEGER NOT NULL REFERENCES slice (id),
      month         TEXT NOT NULL,
      files         INTEGER NOT NULL DEFAULT 0,
      bytes         INTEGER NOT NULL DEFAULT 0,
      pending       INTEGER NOT NULL DEFAULT 0,
      pending_bytes INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE TABLE lens (
      id                 INTEGER PRIMARY KEY,
      slug               TEXT NOT NULL,
      name               TEXT NOT NULL DEFAULT '',
      note               TEXT NOT NULL DEFAULT '',
      definition         TEXT NOT NULL,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL,
      partitions_through INTEGER NOT NULL DEFAULT 0,
      rebuilding         INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE UNIQUE INDEX lens_slug ON lens (slug);

    CREATE TABLE lens_member (
      lens_id      INTEGER NOT NULL REFERENCES lens (id),
      partition_id INTEGER NOT NULL REFERENCES partition (id),
      PRIMARY KEY (lens_id, partition_id)
    ) STRICT, WITHOUT ROWID;
  `);

  return db;
};

/** A slice and one partition of it for each month given; the partitions' ids, in order. */
export const sliceWith = (
  db:     DatabaseSync,
  traits: { venue: string; market: string; dataset: string; variant?: string; grain: string; bundle: string },
  months: string[],
): number[] => {
  const { lastInsertRowid: slice } = db.prepare(
    'INSERT INTO slice (venue, market, dataset, variant, grain, bundle) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(traits.venue, traits.market, traits.dataset, traits.variant ?? '', traits.grain, traits.bundle);

  return months.map(month =>
    Number(db.prepare('INSERT INTO partition (slice_id, month) VALUES (?, ?)').run(slice, month).lastInsertRowid));
};
