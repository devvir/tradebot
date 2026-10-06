/**
 * A series' listing prefix, as SQL over `series` columns spelled
 * `<row>.instrument_id` and `<row>.pattern_id` — what the `series_prefix`
 * trigger writes.
 *
 * **The venue-wide file has no letter folder**: its prefix is
 * `venue/market/dataset[,variant]/@/`, one level shorter than an instrument's.
 * It is the series with no instrument. `@` is only ever the bucket, so a key
 * holding it says which depth it has; and `@` sorts below every letter, so the
 * bucket lists first in its dataset.
 *
 * Any other symbol not starting with a Latin letter files under `_`: one
 * starting with a digit, and gate's Chinese symbols, since `upper` and `GLOB`
 * are ASCII-only in SQLite.
 */
export const PREFIX_OF = (row: string): string => `
  SELECT CASE WHEN i.symbol = '' OR instr(i.symbol, '/') > 0 THEN NULL ELSE
           c.venue || '/' || c.market || '/' || c.dataset
           || CASE WHEN c.variant <> '' THEN ',' || c.variant ELSE '' END
           || '/' || CASE WHEN i.id IS NULL THEN '@/' ELSE
                CASE WHEN upper(substr(i.symbol, 1, 1)) GLOB '[A-Z]'
                     THEN upper(substr(i.symbol, 1, 1)) ELSE '_' END
                || '/' || i.symbol || '/' END END
    FROM pattern p JOIN slice c ON c.id = p.slice_id
    LEFT JOIN instrument i ON i.id = ${row}.instrument_id
   WHERE p.id = ${row}.pattern_id`;

/**
 * The instrument a series of one pattern is a shape of, created where it is
 * new: bound to the pattern's id and the symbol, and answering its `id` and
 * `state`.
 *
 * **One statement for every writer of a series** — a survey or a seed — so the
 * venue's name and the market are read off the pattern's slice, and what kind of
 * instrument a shape holds off the pattern, in one place. A venue-wide bucket is not asked about: it has
 * no instrument.
 */
export const INSTRUMENT_OF = `
  INSERT INTO instrument (venue, market, symbol, kind)
  SELECT c.venue, c.market, ?2, CASE p.holds WHEN 'chain' THEN 'chain' ELSE 'single' END
    FROM pattern p JOIN slice c ON c.id = p.slice_id
   WHERE p.id = ?1
      -- A self-assignment, so the row is untouched and RETURNING still yields it.
      ON CONFLICT (venue, market, symbol) DO UPDATE SET symbol = excluded.symbol
  RETURNING id, state`;

/**
 * The slice a shape publishes into, created where it is new: bound to the
 * server's id, then the market, dataset, variant, grain and bundle, and
 * answering its `id`.
 *
 * **One statement for every writer of a pattern**, as `INSTRUMENT_OF` is for a
 * series. The venue is its name, read off the server's row.
 */
export const SLICE_OF = `
  INSERT INTO slice (venue, market, dataset, variant, grain, bundle)
  SELECT name, ?2, ?3, ?4, ?5, ?6 FROM venue
   WHERE id = ?1
      -- A self-assignment, so the row is untouched and RETURNING still yields it.
      ON CONFLICT (venue, market, dataset, variant, grain, bundle) DO UPDATE SET venue = excluded.venue
  RETURNING id`;

/**
 * The catalog's schema, in one place, because everything that touches it has to
 * agree about the same shape.
 *
 * Every table is `STRICT`: SQLite is otherwise dynamically typed, and a type
 * slip in a database this size surfaces as a query that silently matches
 * nothing.
 */
export const CATALOG_SCHEMA = `
-- One server. A venue published from two hosts is two rows, so (name, host)
-- identifies a server while "name" alone identifies the venue.
CREATE TABLE IF NOT EXISTS venue (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL,

  -- '' where the venue has only one. NOT NULL because SQLite treats NULLs as
  -- distinct in a unique index, which would let one venue insert twice.
  host TEXT NOT NULL DEFAULT '',
  base TEXT NOT NULL,
  key_root TEXT NOT NULL,
  UNIQUE (name, host)
) STRICT;

-- A file the venue serves, and what is known about it.
CREATE TABLE IF NOT EXISTS file (
  venue_id      INTEGER NOT NULL,
  path          TEXT NOT NULL,  -- the key, below the venue's key root
  date          TEXT NOT NULL,  -- the period it holds: yyyymm to yyyymmddhhmi
  size          INTEGER,
  etag          TEXT,
  modified      TEXT,
  series_id     INTEGER NOT NULL REFERENCES series (id),

  -- The partition it belongs to: its series' slice, at the month of its date.
  partition_id  INTEGER NOT NULL REFERENCES partition (id),

  -- Whether the venue still serves it: 'confirmed' or 'absent'. A withdrawn
  -- file is marked, never deleted.
  existence     TEXT NOT NULL,

  seen_at       TEXT NOT NULL,  -- first discovery; never moves
  downloaded_at TEXT,           -- of the version this row describes
  PRIMARY KEY (venue_id, path)
) STRICT;

-- "Which files does this venue hold, in date order".
CREATE INDEX IF NOT EXISTS file_when ON file (venue_id, date);

-- "Every file of this partition".
CREATE INDEX IF NOT EXISTS file_partition ON file (partition_id);

-- Candidate URLs that have not been confirmed yet.
CREATE TABLE IF NOT EXISTS wip (
  -- Unique across inserts, updates and deletes; AUTOINCREMENT never reuses one.
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id  INTEGER NOT NULL,
  path      TEXT NOT NULL,
  date      TEXT NOT NULL,
  size      INTEGER,
  etag      TEXT,
  modified  TEXT,
  series_id INTEGER NOT NULL REFERENCES series (id),

  -- Who named the key: 'confirmed' where a listing did, 'assumed' where this
  -- service built it from a pattern.
  existence TEXT NOT NULL DEFAULT 'confirmed',

  created_at TEXT NOT NULL,              -- enqueued, refreshed if offered again
  tries      INTEGER NOT NULL DEFAULT 0, -- asked and not settled, so far

  -- What to ask the venue for once this row settles, where a period is published
  -- in parts -- the adapter's own token, opaque here, and NULL wherever there is
  -- nothing to ask, which is every key of every venue that publishes a period
  -- whole. A row with none is never taken back to the adapter, which is how a
  -- venue that named every part at once is not asked about that period again.
  --
  -- Stored rather than read back out of the path, which would mean inverting a
  -- pattern's substitution and guessing where the slot ended.
  next_part  TEXT,
  UNIQUE (venue_id, path)
) STRICT;

-- "What is outstanding for this venue, in order".
CREATE INDEX IF NOT EXISTS wip_next ON wip (venue_id, seq);

-- "Is anything of this series still outstanding, and from when".
CREATE INDEX IF NOT EXISTS wip_series ON wip (series_id, date);

-- Every version of a file after the first, appended rather than overwritten.
-- The current one lives in "file"; this is the trail behind it.
CREATE TABLE IF NOT EXISTS revision (
  venue_id      INTEGER NOT NULL,
  path          TEXT NOT NULL,
  seen_at       TEXT NOT NULL,  -- when this version was observed
  size          INTEGER,
  etag          TEXT,
  modified      TEXT,

  -- The state the replaced version had when it was replaced, so the trail says
  -- which versions were ever on disk rather than only which existed.
  downloaded_at TEXT,
  PRIMARY KEY (venue_id, path, seen_at)
) STRICT;

-- "What changed since a given moment", across every venue at once.
CREATE INDEX IF NOT EXISTS revision_when ON revision (seen_at);

-- Specific files a venue serves that are not historical data: wrong bytes at a
-- real URL, a misfiled artifact, a truncated copy of something else.
--
-- An enumeration, not a rule -- "path" is matched exactly, and nothing in this
-- codebase writes it.
CREATE TABLE IF NOT EXISTS exclusion (
  id       INTEGER PRIMARY KEY,
  venue_id INTEGER NOT NULL,
  path     TEXT NOT NULL,
  reason   TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS exclusion_path ON exclusion (venue_id, path);

-- Paths a venue served that no adapter could read into a series.
CREATE TABLE IF NOT EXISTS unreadable (
  venue_id   INTEGER NOT NULL,
  path       TEXT    NOT NULL,

  -- Which way it failed: no adapter placed the path at all, or one placed it
  -- and the venue's own dateOf then declined to date it.
  reason     TEXT    NOT NULL,

  seen       INTEGER NOT NULL DEFAULT 1, -- times this path has been offered
  first_seen TEXT    NOT NULL,
  last_seen  TEXT    NOT NULL,
  PRIMARY KEY (venue_id, path)
) STRICT;

-- Whether this deployment surveys a venue at all. No row means nobody has ever
-- asked for it.
--
-- Keyed by name rather than venue.id, because a venue is what somebody starts
-- and pauses while "venue" has a row per host.
CREATE TABLE IF NOT EXISTS survey (
  venue       TEXT NOT NULL PRIMARY KEY,
  enrolled_at TEXT NOT NULL,

  -- NULL while running. Set when somebody stops it, cleared when they resume.
  paused_at   TEXT
) STRICT;

-- One pass over a venue: a row at the empty scope plus one row per partition,
-- written together and sharing one "started".
CREATE TABLE IF NOT EXISTS run (
  id        INTEGER PRIMARY KEY,
  venue_id  INTEGER NOT NULL,

  -- walk: a listing pass. update: keys generated from patterns, no listing
  -- read. probe: a settling sweep.
  kind      TEXT NOT NULL,

  scope     TEXT NOT NULL,          -- relative prefix; '' is the whole venue
  cursor    TEXT,                   -- where to resume; NULL at the empty scope

  -- Pages: a listing page on a walk, a page of generated keys on an update.
  requests  INTEGER NOT NULL DEFAULT 0,
  found     INTEGER NOT NULL DEFAULT 0,

  -- The moment the archive is read as of. Resuming continues toward it rather
  -- than moving it.
  started   TEXT NOT NULL,
  completed TEXT,

  -- Requests this job needed: one per key probed, one per listing page read.
  -- What compares a walk against an update. Kept on the job row only;
  -- partitions stay at zero.
  asked     INTEGER NOT NULL DEFAULT 0,

  -- The same requests as they actually went out, every retry included.
  sent      INTEGER NOT NULL DEFAULT 0
) STRICT;

-- One open run per scope, so two collectors cannot both claim a partition and
-- two jobs cannot be open over one venue at once.
CREATE UNIQUE INDEX IF NOT EXISTS run_open ON run (venue_id, kind, scope) WHERE completed IS NULL;

-- "Is this prefix established, and as of when", without a scan.
CREATE INDEX IF NOT EXISTS run_scope ON run (venue_id, scope, completed);

-- A named way of looking at the catalog: where one is in force, what it lets
-- through IS the catalog as far as that consumer is concerned. The database
-- underneath stays complete and unfiltered.
CREATE TABLE IF NOT EXISTS lens (
  id         INTEGER PRIMARY KEY,

  -- Lower-case, hyphenated, unique: what a consumer is configured with, and what
  -- every path addresses. Stable, because changing it reconfigures whoever reads
  -- through this lens.
  slug       TEXT NOT NULL,

  -- What a person calls it. Free text, and free to change.
  name       TEXT NOT NULL DEFAULT '',

  -- What it is for, in a person's words. Empty where the name says it.
  note       TEXT NOT NULL DEFAULT '',

  -- The whole definition, as JSON. Nothing queries across its parts: a lens is
  -- read whole and written whole, so normalising it would buy filtering,
  -- searching and indexing, and none of those are wanted.
  definition TEXT NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  -- The newest partition the lens has been resolved against. A partition past
  -- it is one the lens has not looked at yet; it is added to lens_member where
  -- the lens lets it through, and this moves forward.
  partitions_through INTEGER NOT NULL DEFAULT 0,

  -- 1 while what the lens lets through is being worked out again from the first
  -- partition, as saving its rules asks; 0 once the walk has read them all.
  rebuilding INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS lens_slug ON lens (slug);

-- What a lens lets through: its partitions. Worked out again when the lens's
-- rules are saved, settled as new partitions appear, and read by every view
-- through the lens.
CREATE TABLE IF NOT EXISTS lens_member (
  lens_id      INTEGER NOT NULL REFERENCES lens (id),
  partition_id INTEGER NOT NULL REFERENCES partition (id),
  PRIMARY KEY (lens_id, partition_id)
) STRICT, WITHOUT ROWID;

-- One lengthwise cut of a venue's data: a dataset of a market, narrowed by its
-- finer traits. Every pattern publishes into one, and every file belongs to
-- one month of one.
--
-- The venue is its NAME, not a "venue" row: those are servers, and a slice is
-- what is published whichever server publishes it.
CREATE TABLE IF NOT EXISTS slice (
  id      INTEGER PRIMARY KEY,
  venue   TEXT    NOT NULL,

  -- Canonical, never the venue's own words: what gate calls "futures_usdt" is
  -- "perp" here, and its own spelling survives inside "pattern.pattern".
  market  TEXT    NOT NULL,
  dataset TEXT    NOT NULL,
  variant TEXT    NOT NULL DEFAULT '',

  -- How much time one file covers: 'monthly', 'daily', 'hourly', 'minutely'.
  grain   TEXT    NOT NULL,

  -- How many instruments one file holds: 'instrument' for one, 'market' for
  -- every instrument of the market at once.
  bundle  TEXT    NOT NULL,
  UNIQUE (venue, market, dataset, variant, grain, bundle)
) STRICT;

-- One month of a slice: the unit that is downloaded, stocked and stored whole.
-- A row exists once a file does.
--
-- The counters are totals over the partition's rows of "file", moved by the
-- writes that move those rows, so quantities are read rather than aggregated.
CREATE TABLE IF NOT EXISTS partition (
  id            INTEGER PRIMARY KEY,
  slice_id      INTEGER NOT NULL REFERENCES slice (id),
  month         TEXT    NOT NULL,           -- yyyymm
  files         INTEGER NOT NULL DEFAULT 0, -- confirmed
  bytes         INTEGER NOT NULL DEFAULT 0,
  pending       INTEGER NOT NULL DEFAULT 0, -- confirmed and not downloaded
  pending_bytes INTEGER NOT NULL DEFAULT 0,
  withdrawn     INTEGER NOT NULL DEFAULT 0,

  -- What the partition holds, as one number: sixteen hex digits, the sum of
  -- its confirmed files -- each a 64-bit number hashed from its ETag --
  -- wrapped at 64 bits. A file added, withdrawn or changed moves it; one the
  -- venue only moved does not, and the same files give the same version in any
  -- catalog. Summed by this
  -- service rather than in SQL, where an overflowing sum becomes a float.
  version       TEXT    NOT NULL DEFAULT '0000000000000000',

  -- When the version last moved. A download moves nothing here.
  updated_at    TEXT    NOT NULL,
  UNIQUE (slice_id, month)
) STRICT;

-- What a venue's URLs look like: one row per shape, with slots where the parts
-- that vary go.
CREATE TABLE IF NOT EXISTS pattern (
  id       INTEGER PRIMARY KEY,

  -- The server that publishes it.
  venue_id INTEGER NOT NULL,

  -- What it publishes: its market, dataset, variant, grain and bundle are the
  -- slice's. One URL shape publishing into two slices is two rows.
  slice_id INTEGER NOT NULL REFERENCES slice (id),

  -- The shape a URL is built from. Everything that is not a slot is literal:
  --
  --   {SYMBOL}  the archive's spelling of an instrument, stored on the series
  --   {YYYY}    year          {DD}  day of the month
  --   {MM}      month         {HH}  hour        {MI}  minute
  --
  -- three that an adapter fills itself, through its own slotsFor:
  --
  --   {MONTH_LAST_DAY}  bybit, which names a month by both its ends
  --   {EPOCH_HH}        gate, which names a file by the instant it covers
  --   {EPOCH_MI}        in Unix seconds and carries no date at all
  --
  -- and one that reads a table, for the part of a URL no rule reaches:
  --
  --   {TRANSFORM:kind:default}   see "transform"
  pattern  TEXT    NOT NULL,

  -- What one file of this shape holds: 'instrument', or 'chain' where a file
  -- carries every expiry of a family under the family's name. It is what makes
  -- the instruments of its series chains.
  holds    TEXT    NOT NULL DEFAULT 'instrument',

  -- The last date this shape ever served: yyyymm or yyyymmdd, inclusive. NULL
  -- while it is still served. Declared rather than observed, since a missing
  -- file and a tree that has ended are the same answer from an archive.
  retired_at TEXT,
  UNIQUE (venue_id, slice_id, pattern)
) STRICT;

-- The part of a URL that follows no rule: what one instrument puts where a
-- pattern says {TRANSFORM:kind:default}, for a span of dates.
--
-- **For exceptions, not for shapes.** A shape a market shares is a pattern; this
-- is one instrument departing from it. Bitget moved a hundred instruments into
-- directories named after somebody else on one day, and files its futures trades
-- under a token that is a property of the instrument rather than of the market --
-- neither is expressible as a template, and both are one row here.
--
-- A pattern naming a kind is what decides where a row applies, so the row itself
-- says nothing about datasets unless it has to: dataset '' is "wherever a pattern
-- asks", and a named dataset overrides it for that one.
--
-- Absent rows are not an error. The default written into the placeholder stands,
-- which is how one pattern serves the instruments that follow the rule and the
-- ones that do not.
CREATE TABLE IF NOT EXISTS transform (
  venue_id  INTEGER NOT NULL,

  -- Canonical market and symbol: the instrument, as pattern and series name it.
  market    TEXT    NOT NULL,
  symbol    TEXT    NOT NULL,

  -- '' for every dataset whose pattern asks for this kind.
  dataset   TEXT    NOT NULL DEFAULT '',

  -- Which placeholder this answers. Free, and worth being specific: two
  -- exceptions that happen to substitute the same text are still two kinds.
  kind      TEXT    NOT NULL,

  -- What goes in. Substituted before the slots are, so it may carry them:
  -- "{SYMBOL}_3" is a legal transform.
  transform TEXT    NOT NULL,

  -- Inclusive, at the grain of the series that reads it. A directory can be
  -- reassigned more than once, so date_from is part of what makes a row.
  date_from TEXT    NOT NULL,
  date_to   TEXT,

  PRIMARY KEY (venue_id, market, symbol, dataset, kind, date_from)
) STRICT;

-- What a venue trades: one row per instrument, stated once, so that everything
-- true of the instrument -- whether the venue still lists it, and in time what
-- it settles in -- is said here rather than repeated by each of its series.
--
-- The venue is its NAME, not a "venue" row: those are servers, and an instrument
-- belongs to the venue whichever server publishes its files.
CREATE TABLE IF NOT EXISTS instrument (
  id     INTEGER PRIMARY KEY,
  venue  TEXT    NOT NULL,

  -- Canonical, as "slice.market" records it.
  market TEXT    NOT NULL,

  -- The venue's own name for it.
  symbol TEXT    NOT NULL,

  -- 'single', or 'chain': a family whose files hold every one of its expiries,
  -- so that its members are only ever seen inside the files. A chain's members
  -- differ in expiry alone, which is why it can stand as one instrument.
  kind   TEXT    NOT NULL DEFAULT 'single',

  -- What the venue's listing says today: 'active' or 'delisted'. It says
  -- nothing about where the files stop -- an archive outlives a listing.
  state  TEXT    NOT NULL DEFAULT 'active',
  UNIQUE (venue, market, symbol)
) STRICT;

-- One instrument's occupancy of one pattern: where its files start, where they
-- stop, and how far the venue has been asked.
--
-- "Instrument" is not quite the word -- a venue-wide bucket is a row here too,
-- and borrowing rates are keyed by a currency -- but every row has a lifetime
-- and a tip.
CREATE TABLE IF NOT EXISTS series (
  id         INTEGER PRIMARY KEY,
  pattern_id INTEGER NOT NULL REFERENCES pattern (id),

  -- The instrument this series is one shape of, which is where its symbol is.
  -- NULL for a venue-wide bucket, which holds every instrument of a market and
  -- so is none of them.
  instrument_id INTEGER REFERENCES instrument (id),

  -- How the ARCHIVE spells the instrument, where that differs inside the name
  -- rather than around it. NULL means no transformation; a constant written
  -- around the symbol belongs in the pattern instead.
  url_symbol TEXT,

  first      TEXT,  -- oldest date a file has been seen at; NULL where none has
  last       TEXT,  -- newest date a file has been seen at; NULL where none has
  tip        TEXT,  -- settled up to and including this; only ever moves forward

  -- Where the series' files sit in the catalog's listing:
  -- venue/market/dataset[,variant]/F/symbol/ -- F the symbol's first letter,
  -- upper case, or _ for any other -- and venue/market/dataset[,variant]/@/ for
  -- the venue-wide file. Every key of the series starts with it. Written by
  -- series_prefix below, never by hand. NULL where the symbol cannot be a folder
  -- name: empty, or holding a /.
  prefix     TEXT
) STRICT;

-- What makes two series the same series: the shape, the instrument, and the
-- name its keys carry. Over expressions rather than the columns, since SQLite
-- holds NULLs distinct and a pattern has one bucket.
CREATE UNIQUE INDEX IF NOT EXISTS series_key
  ON series (pattern_id, COALESCE(instrument_id, 0), COALESCE(url_symbol, ''));

-- "Which files belong to this series, in order", and what state each is in.
CREATE INDEX IF NOT EXISTS file_series ON file (series_id, date, existence);

-- The files not yet downloaded, by series and date: what a listing of what is
-- owed reads, so walking what is owed costs what is owed rather than every file
-- of every series the walk passes through.
CREATE INDEX IF NOT EXISTS file_pending ON file (series_id, date)
  WHERE downloaded_at IS NULL AND existence = 'confirmed';

-- The listing's order: a venue's series are one range of it, already sorted as
-- their keys sort.
CREATE INDEX IF NOT EXISTS series_prefix ON series (prefix);

-- Every series gets its prefix as it is created, whichever path creates it --
-- a survey, or a seed -- so no writer has to know the listing's layout.
CREATE TRIGGER IF NOT EXISTS series_prefix AFTER INSERT ON series
BEGIN
  UPDATE series SET prefix = (${PREFIX_OF('NEW')}) WHERE id = NEW.id;
END;

-- "Which series belong to this instrument".
CREATE INDEX IF NOT EXISTS series_instrument ON series (instrument_id);
`;

/**
 * Pragmas applied on every open, and one that can only ever be applied at
 * creation.
 *
 * `auto_vacuum = INCREMENTAL` is the one that cannot wait: switching a database
 * to it later requires a full rebuild.
 */
export const AT_CREATION = [
  'PRAGMA auto_vacuum = INCREMENTAL',
] as const;

export const ON_OPEN = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA foreign_keys = ON',
  'PRAGMA synchronous = NORMAL',
] as const;
