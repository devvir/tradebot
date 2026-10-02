
/**
 * The lens table, apart because it arrived after the baseline.
 *
 * **One statement of it, applied from two places.** A catalog built from nothing
 * gets it inside `CATALOG_SCHEMA` below; one already in service gets it from the
 * migration that adds lenses. Written twice they would drift.
 */
export const LENS_SCHEMA = `
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
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS lens_slug ON lens (slug);
`;

/**
 * The cart tables, apart because they arrived after the baseline.
 *
 * **One statement of them, applied from two places.** A catalog built from
 * nothing gets them inside `CATALOG_SCHEMA` below; one already in service gets
 * them from the migration that adds carts. Written twice they would drift, and
 * the drift would show up as a column one deployment has and another does not.
 */
export const CART_SCHEMA = `
-- What somebody wants on disk: a named selection of the catalog, which a
-- downloader reads and fetches. The name is the handle -- hauler asks for
-- "bitmex-backfill", not for a row id.
CREATE TABLE IF NOT EXISTS cart (
  id         INTEGER PRIMARY KEY,

  -- Lower-case, hyphenated, unique: the legible identifier a consumer names.
  name       TEXT NOT NULL,

  -- What it is for, in a person's words. Empty where the name says it.
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS cart_name ON cart (name);

-- One line of a cart: a venue, and how much of it.
--
-- Every column but the venue may be empty, and empty means all of it -- so a
-- venue and nothing else is that venue's whole archive. What a line may not do
-- is admit a combination the venue does not publish: see "carts.ts", which is
-- where that is decided, because a row cannot decide it alone.
CREATE TABLE IF NOT EXISTS cart_item (
  id         INTEGER PRIMARY KEY,
  cart_id    INTEGER NOT NULL REFERENCES cart (id),
  venue_id   INTEGER NOT NULL REFERENCES venue (id),
  market     TEXT NOT NULL DEFAULT '',
  dataset    TEXT NOT NULL DEFAULT '',
  variant    TEXT NOT NULL DEFAULT '',
  grain      TEXT NOT NULL DEFAULT '',

  -- The venue's own spellings, comma separated; empty is every instrument. A
  -- symbol never contains a comma, which is what lets one row hold a list.
  symbols    TEXT NOT NULL DEFAULT '',

  -- Inclusive bounds on the period a file covers, as yyyymmdd. Empty is open:
  -- no start, no end. A monthly file is in range where its month overlaps.
  date_from  TEXT NOT NULL DEFAULT '',
  date_to    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS cart_item_cart ON cart_item (cart_id);
`;

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

  -- Whether the venue still serves it: 'confirmed' or 'absent'. A withdrawn
  -- file is marked, never deleted.
  existence     TEXT NOT NULL,

  seen_at       TEXT NOT NULL,  -- first discovery; never moves
  last_seen     TEXT,           -- most recent sighting
  downloaded_at TEXT,           -- of the version this row describes
  PRIMARY KEY (venue_id, path)
) STRICT;

-- "Which files does this venue hold, in date order".
CREATE INDEX IF NOT EXISTS file_when ON file (venue_id, date);

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

${CART_SCHEMA}
${LENS_SCHEMA}

-- Rollups: totals over \`file\`, kept in step with it so quantities are read
-- rather than aggregated. Per venue and month, for the constant questions.
CREATE TABLE IF NOT EXISTS rollup_venue (
  venue_id      INTEGER NOT NULL,
  month         TEXT    NOT NULL,           -- yyyymm
  files         INTEGER NOT NULL DEFAULT 0, -- confirmed
  bytes         INTEGER NOT NULL DEFAULT 0,
  pending       INTEGER NOT NULL DEFAULT 0, -- confirmed and not downloaded
  pending_bytes INTEGER NOT NULL DEFAULT 0,
  withdrawn     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (venue_id, month)
) STRICT;

-- "Which months have work left", across every venue at once.
CREATE INDEX IF NOT EXISTS rollup_venue_pending ON rollup_venue (pending) WHERE pending > 0;

-- Per series and month, for anything narrower than a venue — a lens above all.
CREATE TABLE IF NOT EXISTS rollup_series (
  series_id     INTEGER NOT NULL,
  month         TEXT    NOT NULL,           -- yyyymm
  files         INTEGER NOT NULL DEFAULT 0, -- confirmed
  bytes         INTEGER NOT NULL DEFAULT 0,
  pending       INTEGER NOT NULL DEFAULT 0, -- confirmed and not downloaded
  pending_bytes INTEGER NOT NULL DEFAULT 0,
  withdrawn     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (series_id, month)
) STRICT;

-- What a venue's URLs look like: one row per shape, with slots where the parts
-- that vary go.
CREATE TABLE IF NOT EXISTS pattern (
  id       INTEGER PRIMARY KEY,
  venue_id INTEGER NOT NULL,

  -- Canonical, never the venue's own words: what gate calls "futures_usdt" is
  -- "perp" here, and its own spelling survives inside "pattern".
  market   TEXT    NOT NULL,
  dataset  TEXT    NOT NULL,
  variant  TEXT    NOT NULL DEFAULT '',

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

  -- How often the shape publishes, from the finest slot the pattern carries.
  grain    TEXT    NOT NULL DEFAULT 'monthly',

  -- The last date this shape ever served: yyyymm or yyyymmdd, inclusive. NULL
  -- while it is still served. Declared rather than observed, since a missing
  -- file and a tree that has ended are the same answer from an archive.
  retired_at TEXT,
  UNIQUE (venue_id, market, dataset, pattern)
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

-- One instrument's occupancy of one pattern: where its files start, where they
-- stop, and how far the venue has been asked.
--
-- "Instrument" is not quite the word -- a venue-wide bucket is a row here too,
-- and borrowing rates are keyed by a currency -- but every row has a lifetime
-- and a tip.
CREATE TABLE IF NOT EXISTS series (
  id         INTEGER PRIMARY KEY,
  pattern_id INTEGER NOT NULL REFERENCES pattern (id),

  -- The venue's own name for the instrument. "@" where one file carries every
  -- instrument of a market.
  symbol     TEXT    NOT NULL DEFAULT '',

  -- How the ARCHIVE spells it, where that differs inside the name rather than
  -- around it. NULL means no transformation; a constant written around the
  -- symbol belongs in the pattern instead.
  url_symbol TEXT,

  first      TEXT,  -- oldest date a file has been seen at; NULL where none has
  last       TEXT,  -- newest date a file has been seen at; NULL where none has
  tip        TEXT,  -- settled up to and including this; only ever moves forward

  -- What the venue's listing says today: 'active' or 'delisted'. It says
  -- nothing about where the files stop -- an archive outlives a listing.
  state      TEXT    NOT NULL DEFAULT 'active'
) STRICT;

-- What makes two series the same series: the shape, and the name its keys
-- carry. Over the expression rather than the column, so a url_symbol written
-- out and one left implicit collide as they should.
CREATE UNIQUE INDEX IF NOT EXISTS series_key
  ON series (pattern_id, COALESCE(url_symbol, symbol));

-- "Which files belong to this series, in order", and what state each is in.
CREATE INDEX IF NOT EXISTS file_series ON file (series_id, date, existence);

-- "Which series belong to this symbol".
CREATE INDEX IF NOT EXISTS series_symbol ON series (symbol);
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

/**
 * The files not yet downloaded, by series and date — what a "pending only"
 * bucket listing reads, so walking what is owed costs what is owed rather than
 * every file of every series the walk passes through.
 */
export const PENDING_INDEX = `
CREATE INDEX IF NOT EXISTS file_pending ON file (series_id, date)
  WHERE downloaded_at IS NULL AND existence = 'confirmed';
`;
