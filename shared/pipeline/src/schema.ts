/**
 * One table, and the whole point is that there is only one.
 *
 * Every stage of the pipeline tells the next where it has got to, and until now
 * each did it its own way — a TSV of month closings here, positional columns
 * there, 336MB of JSONL somewhere else. A consumer had to learn a format, a
 * grain and a set of conventions per producer. One shape means a new collector
 * arrives already legible.
 *
 * `STRICT` because SQLite is otherwise dynamically typed and a declared `TEXT`
 * column will hold whatever it is given — which surfaces as a query that
 * silently matches nothing, months later.
 */
export const FACT_SCHEMA = `
-- Every discriminant is NOT NULL DEFAULT '' rather than nullable. SQLite treats
-- NULLs as DISTINCT in a unique index, so two archive facts both leaving
-- "market" unset would both insert and the primary key would protect nothing.
-- The empty string means "this topic has no such dimension" and compares like
-- any other value.
--
-- WITHOUT ROWID because the key IS the row: there is no second identity worth
-- storing, and every read is a prefix of that key.
CREATE TABLE IF NOT EXISTS fact (
  topic    TEXT NOT NULL,
  venue    TEXT NOT NULL,
  period   TEXT NOT NULL,
  market   TEXT NOT NULL DEFAULT '',
  symbol   TEXT NOT NULL DEFAULT '',
  dataset  TEXT NOT NULL DEFAULT '',
  subject  TEXT NOT NULL DEFAULT '',
  fact     TEXT NOT NULL,
  -- Blank for almost everything, and that is the design: a fact describes state,
  -- so re-stating it replaces it. "seq" is what lets a fact be additive instead
  -- -- an occurrence rather than a condition -- by making otherwise-identical
  -- keys distinct. A timestamp is the useful value, since it also orders them.
  seq      TEXT NOT NULL DEFAULT '',
  value    TEXT NOT NULL DEFAULT '',
  meta     TEXT NOT NULL DEFAULT '',
  -- Free to keep and impossible to add retroactively. "created_at" never moves
  -- after the first statement; "updated_at" moves on every re-statement, whether
  -- or not the value changed -- "we heard this again" and "this changed" are
  -- different facts and only one of them is visible in the value.
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (topic, venue, period, market, symbol, dataset, subject, fact, seq)
) STRICT, WITHOUT ROWID;

-- The primary key leads with topic and venue, which serves every query that
-- names them. This one serves the other shape: "which venues have this fact",
-- and "everything asserted about this month", neither of which knows a venue up
-- front.
CREATE INDEX IF NOT EXISTS fact_by_kind ON fact (topic, fact, period);

-- Three orderings for three ways of slicing, and no more than that.
--
-- The primary key answers thing-first: this venue, this month, this partition.
-- "fact_by_kind" answers assertion-first: who says X -- which is what makes a
-- raw path lookup in vault:details a seek, since there the fact IS the path.
-- This one answers time-first: what happened in this period, across venues.
--
-- Time-first is the one a websocket or REST collector will ask constantly and
-- the one the key cannot serve at all: "venue" sits second, so a question that
-- does not name a venue falls back to scanning the topic. Measured on 3.1M
-- rows that is 0.68s against 0.00s, and it only gets worse as collectors that
-- write per-day arrive.
CREATE INDEX IF NOT EXISTS fact_by_time ON fact (topic, period, venue);
`;

/**
 * Set once, at creation, because `auto_vacuum` takes effect only on a database
 * with no tables in it yet.
 */
export const AT_CREATION = [
  'PRAGMA auto_vacuum = INCREMENTAL',
];

/**
 * **WAL is what makes a live service and a curious tool coexist.** Readers do
 * not block the writer and the writer does not block readers, which is the
 * whole premise of one owner writing while anything else looks on.
 */
export const ON_OPEN = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA foreign_keys = ON',
];

/** Bumped when the shape changes; there is nothing to migrate from yet. */
export const SCHEMA_VERSION = 1;
