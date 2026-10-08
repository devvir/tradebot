import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The record of cold storage: every tar, and which partitions each one holds.
 *
 * **It is the only thing that knows what a tar holds.** A tar's name says which
 * venue-month it belongs to and nothing about what is inside, so losing this
 * loses the map — and it belongs in the backup beside the data it describes.
 *
 * **Partitions, not files.** The catalog's version of a partition stands for
 * every file in it, so a tar is recorded as the partitions it holds and the
 * version of each. That is what says whether a partition is stored, whether what
 * is stored is still current, and which tar to bring back to get it.
 */

/** Open the record, creating it where it does not exist. */
export const open = (file: string): DatabaseSync => {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  return db;
};

export const close = (db: DatabaseSync): void => {
  try {
    db.close();
  } catch {
    // Already closed: an exit handler and a `finally` both reach here.
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

const SCHEMA = `
-- One tar in cold storage, or on its way there. A venue-month has as many as it
-- takes, numbered in the order they were planned.
CREATE TABLE IF NOT EXISTS tar (
  id         INTEGER PRIMARY KEY,
  origin     TEXT    NOT NULL,
  venue      TEXT    NOT NULL,
  month      TEXT    NOT NULL,           -- yyyymm
  seq        INTEGER NOT NULL,

  -- Below the origin's root in Mega, and below its staging directory here.
  -- Neither holds a root: those come from the environment on every use.
  remote     TEXT    NOT NULL,
  local      TEXT    NOT NULL,

  bytes      INTEGER,                    -- known once packed
  state      TEXT    NOT NULL,           -- planned, packed, queued, stored; stale, fetching, fetched
  handle     TEXT,                       -- Mega's own identifier for the stored object
  planned_at TEXT    NOT NULL,
  stored_at  TEXT,
  UNIQUE (origin, venue, month, seq)
) STRICT;

CREATE INDEX IF NOT EXISTS tar_state ON tar (origin, state);

-- A partition inside a tar, at the catalog version it was packed at. A
-- partition is in one tar and no other.
CREATE TABLE IF NOT EXISTS held (
  tar_id  INTEGER NOT NULL REFERENCES tar (id),
  origin  TEXT    NOT NULL,
  venue   TEXT    NOT NULL,
  market  TEXT    NOT NULL,
  dataset TEXT    NOT NULL,
  variant TEXT    NOT NULL,
  grain   TEXT    NOT NULL,
  bundle  TEXT    NOT NULL,
  month   TEXT    NOT NULL,
  version TEXT    NOT NULL,
  files   INTEGER NOT NULL,
  bytes   INTEGER NOT NULL,

  -- What the catalog holds now, where the tar holds something older: the tar is
  -- brought back and corrected to this.
  next_version TEXT,
  next_files   INTEGER,
  next_bytes   INTEGER,
  PRIMARY KEY (origin, venue, market, dataset, variant, grain, bundle, month)
) STRICT;

CREATE INDEX IF NOT EXISTS held_tar ON held (tar_id);

-- A partition taken off the local disk because cold storage holds it, and when.
-- One row each time: the history of what was moved out, which the tree itself
-- does not keep. One brought back since says when, and from then on is history
-- only: the partition is on disk again, and is not one that was taken off it.
CREATE TABLE IF NOT EXISTS eviction (
  origin     TEXT    NOT NULL,
  venue      TEXT    NOT NULL,
  market     TEXT    NOT NULL,
  dataset    TEXT    NOT NULL,
  variant    TEXT    NOT NULL,
  grain      TEXT    NOT NULL,
  bundle     TEXT    NOT NULL,
  month      TEXT    NOT NULL,
  version    TEXT    NOT NULL,           -- the version cold storage held of it
  files      INTEGER NOT NULL,           -- what was removed from disk
  bytes      INTEGER NOT NULL,
  evicted_at TEXT    NOT NULL,
  returned_at TEXT                       -- brought back to the local disk, and when
) STRICT;

CREATE INDEX IF NOT EXISTS eviction_venue ON eviction (origin, venue);

-- One file of the vault in cold storage, or on its way there: a partition
-- stored whole, or one instrument of a partition stored per instrument. The
-- vault is stored as it is — the same files, at the same paths — so there is no
-- tar to describe, and a file is found in cold storage where it is on disk.
CREATE TABLE IF NOT EXISTS vault_file (
  partition  TEXT    NOT NULL,           -- the slice's directory below the vault, then its month
  revision   TEXT    NOT NULL,
  instrument TEXT    NOT NULL,           -- '@' for the one file of a partition stored whole
  side       TEXT    NOT NULL,           -- '' the month's own rows; 'pre', 'post' what a neighbouring month held of it
  path       TEXT    NOT NULL,           -- below the vault
  bytes      INTEGER NOT NULL,
  state      TEXT    NOT NULL,           -- planned, queued, stored
  handle     TEXT,                       -- Mega's own identifier for the stored object
  stored_at  TEXT,
  evicted_at TEXT,                       -- taken off the local disk and not brought back
  PRIMARY KEY (partition, revision, instrument, side)
) STRICT;

CREATE INDEX IF NOT EXISTS vault_file_state ON vault_file (state);

-- A vault partition every file of which is in cold storage, at the revision
-- that is. Written when the last of its files is confirmed, and what "stored"
-- means for a partition.
CREATE TABLE IF NOT EXISTS vault_partition (
  partition TEXT    NOT NULL,
  revision  TEXT    NOT NULL,
  files     INTEGER NOT NULL,
  bytes     INTEGER NOT NULL,
  stored_at TEXT    NOT NULL,
  PRIMARY KEY (partition, revision)
) STRICT;

-- A vault file taken off the local disk, or brought back to it, and when. One
-- row each time: the history, where vault_file says only how things stand.
CREATE TABLE IF NOT EXISTS vault_move (
  partition  TEXT    NOT NULL,
  revision   TEXT    NOT NULL,
  instrument TEXT    NOT NULL,
  side       TEXT    NOT NULL,
  bytes      INTEGER NOT NULL,
  action     TEXT    NOT NULL,           -- evicted, restored
  moved_at   TEXT    NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS vault_move_file ON vault_move (partition, instrument);

-- What of the catalog has a copy in cold storage, and at which version. The
-- base is the database itself, whole. Every partition has a row from then on:
-- with no file of its own while it is as the base has it, and with one once
-- it has changed since. A partition's file is sent when the catalog's version
-- of it is no longer the one written here.
CREATE TABLE IF NOT EXISTS catalog_copy (
  name      TEXT    PRIMARY KEY,         -- the partition, or the table
  kind      TEXT    NOT NULL,            -- base, partition
  remote    TEXT    NOT NULL,            -- below the catalog's place in Mega; '' while it is as the base has it
  version   TEXT    NOT NULL,
  bytes     INTEGER NOT NULL,            -- what the file sent weighs
  state     TEXT    NOT NULL,            -- queued, stored
  handle    TEXT,                        -- Mega's own identifier for the stored object
  stored_at TEXT,
  schema    TEXT                         -- the base: how the files' table was declared as it was taken
) STRICT;
`;
