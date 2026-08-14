import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MemberRow, Origin, PartRow, PlannedPart, SourceFile } from './types';

/**
 * The record of what is in cold storage, and the only thing that knows it.
 *
 * **Nothing is derivable from a tar's name.** A part is `202405.p01.tar` and
 * says nothing about its contents, which is deliberate: it lets bin packing put
 * twenty thin symbols in one tar and a fat one on its own without the name
 * having to express either. The price is that losing this database loses the
 * map, so it lives beside the data it describes and is backed up with it.
 *
 * Rows are written **before** the tar exists. A crash then leaves a plan that
 * can be resumed rather than a tar nobody can identify — which would have to be
 * thrown away, since nothing else records what went into it.
 *
 * **The schema is the whole story, applied on every open.** Every statement in
 * it is `IF NOT EXISTS`, so opening an existing database adds whatever is new
 * and changes nothing else — an index arriving later costs one build on the
 * next open and nothing after that. There is one database on one machine, so a
 * versioned migration framework would be scaffolding around a problem nobody
 * has; anything the schema cannot express is a query run once, by hand.
 */
export const open = (dbPath: string): DatabaseSync => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  /**
   * **Two origins can be pushing at once, so a writer has to wait its turn.**
   *
   * The lock is per origin, because what two runs would collide over is a tree
   * and the tars staged from it — but they share this file. WAL lets readers run
   * alongside a writer, and leaves two *writers* to collide: without a timeout
   * the second gets `SQLITE_BUSY` immediately and a plan fails for no better
   * reason than that the other run happened to be committing.
   *
   * Every write here is a handful of statements against a small table, so the
   * wait is milliseconds and the timeout is really an upper bound on a fluke.
   */
  db.exec('PRAGMA busy_timeout = 30000');
  db.exec(SCHEMA);
  addColumns(db);

  return db;
};

/**
 * The one thing `IF NOT EXISTS` cannot do.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves an existing table exactly as it is, so a
 * column added to the schema above reaches a new database and no other. Asking
 * what the table already has and adding only what is missing keeps the same
 * property the rest of the schema has — applied on every open, a no-op after
 * the first — without a version number or a framework to carry it.
 */
const addColumns = (db: DatabaseSync): void => {
  const added: Record<string, Record<string, string>> = {
    part:       { replan:   'INTEGER NOT NULL DEFAULT 0' },
    ghost:      { approved: 'INTEGER NOT NULL DEFAULT 0' },
    superseded: { origin:   `TEXT NOT NULL DEFAULT ''` },
  };

  for (const [table, columns] of Object.entries(added)) {
    const present = new Set((db.prepare(`PRAGMA table_info(${table})`)
      .all() as unknown as { name: string }[]).map(column => column.name));

    for (const [column, type] of Object.entries(columns))
      if (! present.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
};

/**
 * Close the handle, and mean it whichever route gets here first.
 *
 * **Two of them race on Ctrl-C.** The signal handler closes the database and
 * exits; inquirer separately rejects the open prompt, and that rejection unwinds
 * through the caller's `finally`, which closes it again. `node:sqlite` throws
 * `database is not open` on the second call — and because it throws from a
 * `finally`, it *replaces* the cancellation the caller was about to recognise,
 * turning a clean Ctrl-C into an error nobody can act on.
 *
 * Nothing else is needed here. Closing the last connection is what checkpoints
 * the write-ahead log and removes the `-wal` and `-shm` files — so those files
 * outliving a run are not something to tidy up afterwards, they are the symptom
 * of a close that did not happen.
 */
export const close = (db: DatabaseSync): void => {
  if (shut.has(db)) return;

  shut.add(db);
  db.close();
};

/** Every path already packed, with what it looked like when it was. */
export const packed = (db: DatabaseSync, origin: Origin): Map<string, MemberRow> => {
  const rows = db.prepare(
    `SELECT m.path, m.bytes, m.mtime
       FROM member m JOIN part p ON p.id = m.part_id
      WHERE p.origin = ?`,
  ).all(origin) as unknown as MemberRow[];

  return new Map(rows.map(row => [row.path, row]));
};

/**
 * Write one part and its members as a single transaction.
 *
 * The two are meaningless apart — a part with no members is a tar of nothing,
 * and members with no part belong nowhere — so a half-written plan must not be
 * a state the next run can find.
 */
export const plan = (
  db:     DatabaseSync,
  part:   Omit<PlannedPart, 'id'>,
  files:  SourceFile[],
  replan = false,
): number => {
  db.exec('BEGIN');

  try {
    db.prepare(
      `INSERT INTO part (origin, venue, month, seq, name, remote, local, bytes, files,
                         planned_at, replan)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(part.origin, part.venue, part.month, part.seq, part.name,
      part.remote, part.local, part.bytes, part.files, new Date().toISOString(),
      replan ? 1 : 0);

    const id = Number(db.prepare('SELECT last_insert_rowid() AS id').get()!.id);

    const insert = db.prepare(
      `INSERT INTO member (part_id, path, bytes, mtime, venue, market, symbol, dataset, variant, month)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const file of files)
      insert.run(id, file.path, file.bytes, file.mtime, file.venue,
        file.market, file.symbol, file.dataset, file.variant, file.month);

    db.exec('COMMIT');

    return id;
  } catch (err) {
    db.exec('ROLLBACK');

    throw err;
  }
};

/** Every part of an origin, whatever state it is in — the audit's starting point. */
export const allParts = (db: DatabaseSync, origin: Origin): PartRow[] =>
  db.prepare(
    `SELECT id, origin, venue, month, seq, name, remote, local, bytes, files,
            uploaded_at AS uploadedAt, handle, replan
       FROM part WHERE origin = ? ORDER BY venue, month, seq`,
  ).all(origin) as unknown as PartRow[];

/**
 * Files recorded in more than one part.
 *
 * Ordinary after a rebuild — the previous version stays in its tar while the new
 * one is packed beside it — so this reports rather than accuses. A runaway count
 * is what a replanning loop would look like.
 */
export const duplicatedPaths = (db: DatabaseSync, origin: Origin): { path: string; copies: number }[] =>
  db.prepare(
    `SELECT m.path, COUNT(*) AS copies
       FROM member m JOIN part p ON p.id = m.part_id
      WHERE p.origin = ?
      GROUP BY m.path HAVING COUNT(*) > 1
      ORDER BY copies DESC LIMIT 200`,
  ).all(origin) as unknown as { path: string; copies: number }[];

/** Parts that still have to get to Mega, oldest month first. */
export const outstanding = (db: DatabaseSync, origin: Origin): PartRow[] =>
  db.prepare(
    `SELECT id, origin, venue, month, seq, name, remote, local, bytes, files,
            uploaded_at AS uploadedAt, handle, replan
       FROM part
      WHERE origin = ? AND uploaded_at IS NULL
      ORDER BY month, venue, seq`,
  ).all(origin) as unknown as PartRow[];

/**
 * Every part of one venue-month, in sequence order.
 *
 * The unit a replan works in. A month's parts are decided together — bin packing
 * puts a symbol wherever it fits — so which tar holds a given member is an
 * accident of the last plan, and comparing one part against its former self
 * answers a question nobody asked.
 */
export const partsIn = (
  db:     DatabaseSync,
  origin: Origin,
  venue:  string,
  month:  string,
): PartRow[] =>
  db.prepare(
    `SELECT id, origin, venue, month, seq, name, remote, local, bytes, files,
            uploaded_at AS uploadedAt, handle, replan
       FROM part
      WHERE origin = ? AND venue = ? AND month = ?
      ORDER BY seq`,
  ).all(origin, venue, month) as unknown as PartRow[];

/**
 * Every member of a venue-month, across all of its parts, whole.
 *
 * `packedIn` answers the planner's question — has this path changed — and needs
 * only size and mtime. A replan has to *repack* what it finds, so it needs the
 * levels the packer groups by, and the union across parts rather than one part's
 * share of it.
 */
export const monthMembers = (
  db:     DatabaseSync,
  origin: Origin,
  venue:  string,
  month:  string,
): SourceFile[] =>
  db.prepare(
    `SELECT m.path, m.bytes, m.mtime, m.venue, m.market, m.symbol,
            m.dataset, m.variant, m.month
       FROM member m JOIN part p ON p.id = m.part_id
      WHERE p.origin = ? AND p.venue = ? AND p.month = ?`,
  ).all(origin, venue, month) as unknown as SourceFile[];

/** Note an object a replan orphaned, for deletion once its replacements land. */
export const markGhost = (
  db:     DatabaseSync,
  origin: Origin,
  venue:  string,
  month:  string,
  remote: string,
): void => {
  db.prepare(
    `INSERT OR IGNORE INTO ghost (origin, venue, month, remote) VALUES (?, ?, ?, ?)`,
  ).run(origin, venue, month, remote);
};

/**
 * Orphans whose whole month is now safely in Mega.
 *
 * The condition is the point: an orphan is only removable once every part that
 * replaced it has landed, so a run interrupted between the two leaves the old
 * object exactly where it is.
 */
export const removableGhosts = (db: DatabaseSync, origin: Origin): {
  venue: string; month: string; remote: string;
}[] => db.prepare(
  `SELECT g.venue, g.month, g.remote FROM ghost g
    WHERE g.origin = ? AND g.approved = 1
      AND NOT EXISTS (SELECT 1 FROM part p
                       WHERE p.origin = g.origin AND p.venue = g.venue
                         AND p.month = g.month AND p.uploaded_at IS NULL)
    ORDER BY g.venue, g.month`,
).all(origin) as unknown as { venue: string; month: string; remote: string }[];

/** Orphans nobody has ruled on yet — what a run asks about before it starts. */
export const unapprovedGhosts = (db: DatabaseSync, origin: Origin): {
  venue: string; month: string; remote: string;
}[] => db.prepare(
  `SELECT venue, month, remote FROM ghost
    WHERE origin = ? AND approved = 0 ORDER BY venue, month`,
).all(origin) as unknown as { venue: string; month: string; remote: string }[];

/**
 * Approve exactly what was shown, never more.
 *
 * A run filtered to one venue lists that venue's orphans and no others, so
 * approving the origin wholesale would take consent given for what was on screen
 * and apply it to what was not.
 */
export const approveGhosts = (db: DatabaseSync, origin: Origin, venues: string[] = []): void => {
  if (venues.length === 0) {
    db.prepare('UPDATE ghost SET approved = 1 WHERE origin = ?').run(origin);

    return;
  }

  const holes = venues.map(() => '?').join(', ');

  db.prepare(`UPDATE ghost SET approved = 1 WHERE origin = ? AND venue IN (${holes})`)
    .run(origin, ...venues);
};

/** Every object a replan orphaned, removable or not — the audit's question. */
export const ghosts = (db: DatabaseSync, origin: Origin): string[] =>
  (db.prepare('SELECT remote FROM ghost WHERE origin = ?')
    .all(origin) as unknown as { remote: string }[]).map(row => row.remote);

export const forgetGhost = (db: DatabaseSync, origin: Origin, remote: string): void => {
  db.prepare('DELETE FROM ghost WHERE origin = ? AND remote = ?').run(origin, remote);
};

/** The next sequence number for a venue-month, so a later run appends parts. */
export const nextSeq = (db: DatabaseSync, origin: Origin, venue: string, month: string): number => {
  const row = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS seq FROM part WHERE origin = ? AND venue = ? AND month = ?',
  ).get(origin, venue, month) as unknown as { seq: number };

  return row.seq + 1;
};

export const markUploaded = (db: DatabaseSync, id: number, handle: string | null): void => {
  db.prepare('UPDATE part SET uploaded_at = ?, handle = ? WHERE id = ?')
    .run(new Date().toISOString(), handle, id);
};

/** Totals for `cold stats`, and for the line a run prints when it finishes. */
export const totals = (db: DatabaseSync, origin: Origin): {
  parts: number; uploaded: number; bytes: number; uploadedBytes: number; files: number;
} => db.prepare(
  `SELECT COUNT(*)                                        AS parts,
          COALESCE(SUM(uploaded_at IS NOT NULL), 0)       AS uploaded,
          COALESCE(SUM(bytes), 0)                         AS bytes,
          COALESCE(SUM(CASE WHEN uploaded_at IS NOT NULL THEN bytes ELSE 0 END), 0)
                                                          AS uploadedBytes,
          COALESCE(SUM(files), 0)                         AS files
     FROM part WHERE origin = ?`,
).get(origin) as never;

/** Forget a plan entirely, so its surviving files are planned again from scratch. */
export const dropPart = (db: DatabaseSync, id: number): void => {
  db.exec('BEGIN');

  try {
    db.prepare('DELETE FROM member WHERE part_id = ?').run(id);
    db.prepare('DELETE FROM part WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');

    throw err;
  }
};

/** How many partitions are in cold storage for real, rather than merely planned. */
export const uploadedPaths = (db: DatabaseSync, origin: Origin): number =>
  (db.prepare(
    `SELECT COUNT(*) AS n FROM member m JOIN part p ON p.id = m.part_id
      WHERE p.origin = ? AND p.uploaded_at IS NOT NULL`,
  ).get(origin) as unknown as { n: number }).n;

/** The part a staged tar belongs to, or null when nothing claims it. */
export const partByLocal = (db: DatabaseSync, origin: Origin, local: string): PartRow | null =>
  (db.prepare(
    `SELECT id, origin, venue, month, seq, name, remote, local, bytes, files,
            uploaded_at AS uploadedAt, handle, replan
       FROM part WHERE origin = ? AND local = ?`,
  ).get(origin, local) as unknown as PartRow | undefined) ?? null;

/**
 * Take back a claim that a part is in cold storage.
 *
 * Used when a tar is still on disk for a part marked uploaded and Mega turns
 * out not to hold it after all — the record was wrong, and saying so is the
 * only way the part gets sent.
 */
export const clearUploaded = (db: DatabaseSync, id: number): void => {
  db.prepare('UPDATE part SET uploaded_at = NULL, handle = NULL WHERE id = ?').run(id);
};

/**
 * The closing each venue-month was last planned against.
 *
 * **This is a gate, not a record of what is packed.** `member` remains the
 * authority on what is in cold storage; this only says a month has been looked
 * at against a given closing, so the next run can skip walking it. A month the
 * producer re-closes gets a different time and is walked again, and only the
 * files that are genuinely new become parts.
 *
 * It exists because the alternative does not scale. The vault diffs its whole
 * tree every run, which is fine at 190,000 partitions; the raw archives hold
 * 4.9 million files today and are expected to grow by tens of terabytes, and
 * rebuilding that map every run to discover that nothing closed months ago has
 * changed is work with a known answer.
 */
export const closings = (db: DatabaseSync, origin: Origin): Map<string, string> => {
  const rows = db.prepare('SELECT venue, month, closed_at AS closedAt FROM month WHERE origin = ?')
    .all(origin) as unknown as { venue: string; month: string; closedAt: string }[];

  return new Map(rows.map(row => [`${row.venue}/${row.month}`, row.closedAt]));
};

export const rememberMonth = (
  db:       DatabaseSync,
  origin:   Origin,
  venue:    string,
  month:    string,
  closedAt: string,
): void => {
  db.prepare(
    `INSERT INTO month (origin, venue, month, closed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (origin, venue, month) DO UPDATE SET closed_at = excluded.closed_at`,
  ).run(origin, venue, month, closedAt);
};

/**
 * Drop a month's gate so the next run walks it again.
 *
 * Called whenever one of its plans is discarded. Without it a month could be
 * marked as looked at, have its unpacked plans thrown away for being stale, and
 * then never be looked at again — a silent hole in cold storage.
 */
export const forgetMonth = (
  db:     DatabaseSync,
  origin: Origin,
  venue:  string,
  month:  string,
): void => {
  db.prepare('DELETE FROM month WHERE origin = ? AND venue = ? AND month = ?')
    .run(origin, venue, month);
};

/** Every path already packed for one venue-month, with what it looked like then. */
export const packedIn = (
  db:     DatabaseSync,
  origin: Origin,
  venue:  string,
  month:  string,
): Map<string, MemberRow> => {
  const rows = db.prepare(
    `SELECT m.path, m.bytes, m.mtime
       FROM member m JOIN part p ON p.id = m.part_id
      WHERE p.origin = ? AND m.venue = ? AND m.month = ?`,
  ).all(origin, venue, month) as unknown as MemberRow[];

  return new Map(rows.map(row => [row.path, row]));
};

/**
 * Every file of an origin that is genuinely in cold storage, with what it
 * looked like when it was packed.
 *
 * **Uploaded parts only.** A planned part has members too, and they are exactly
 * the files nothing has backed up yet — reading them as safe is how eviction
 * would delete the one copy.
 */
export const uploaded = (db: DatabaseSync, origin: Origin, venue?: string): {
  path: string; bytes: number; mtime: number; venue: string; month: string;
  market: string | null; symbol: string | null; dataset: string | null; variant: string | null;
}[] => db.prepare(
  `SELECT m.path, m.bytes, m.mtime, m.venue, m.month,
          m.market, m.symbol, m.dataset, m.variant
     FROM member m JOIN part p ON p.id = m.part_id
    WHERE p.origin = ? AND p.uploaded_at IS NOT NULL${venue ? ' AND m.venue = ?' : ''}`,
).all(...(venue ? [origin, venue] : [origin])) as never;

/**
 * Venues with anything in cold storage, from the parts alone.
 *
 * **Asked of `part`, never of `member`.** The same answer can be had by reading
 * every member row and collecting the distinct venues, and that is what this
 * replaced: 2.46 million rows and 67 seconds to produce six strings, before the
 * command had printed anything or could answer a Ctrl-C. A part already names
 * its venue, and there are a few hundred of them.
 */
export const venues = (db: DatabaseSync, origin: Origin): string[] =>
  (db.prepare(
    `SELECT DISTINCT venue FROM part WHERE origin = ? AND uploaded_at IS NOT NULL ORDER BY venue`,
  ).all(origin) as unknown as { venue: string }[]).map(row => row.venue);

/**
 * Venue-months that still have a part waiting to go.
 *
 * A month is only a candidate once **every** part of it is in Mega — one tar
 * outstanding means part of that month exists nowhere else.
 */
export const unsentMonths = (db: DatabaseSync, origin: Origin): Set<string> =>
  new Set((db.prepare(
    `SELECT DISTINCT venue, month FROM part WHERE origin = ? AND uploaded_at IS NULL`,
  ).all(origin) as unknown as { venue: string; month: string }[])
    .map(row => `${row.venue}/${row.month}`));

/**
 * Preserve what Mega holds at a path, before the plan describing it is dropped.
 *
 * Idempotent on the remote: re-recording replaces, so a plan dropped twice
 * across runs cannot accumulate two descriptions of one object.
 */
export const supersede = (
  db:      DatabaseSync,
  origin:  Origin,
  remote:  string,
  members: MemberRow[],
): void => {
  db.exec('BEGIN');

  try {
    db.prepare('DELETE FROM superseded WHERE origin = ? AND remote = ?').run(origin, remote);

    const insert = db.prepare(
      'INSERT INTO superseded (origin, remote, path, bytes, mtime, recorded_at) VALUES (?, ?, ?, ?, ?, ?)');
    const at     = new Date().toISOString();

    for (const member of members) insert.run(origin, remote, member.path, member.bytes, member.mtime, at);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');

    throw err;
  }
};

/** What the object at a remote path was last known to hold, if anything. */
export const supersededAt = (
  db:     DatabaseSync,
  origin: Origin,
  remote: string,
): Map<string, MemberRow> =>
  new Map((db.prepare('SELECT path, bytes, mtime FROM superseded WHERE origin = ? AND remote = ?')
    .all(origin, remote) as unknown as MemberRow[]).map(row => [row.path, row]));

/**
 * Every path under one origin with a description waiting to be resolved.
 *
 * **Scoped by origin, because the table is shared.** A row is keyed by the
 * object it describes, so asking for all of them hands one origin the other's
 * rows — which read as objects Mega does not have, since the listing a run holds
 * covers its own tree only. `push` would then resolve them: forgetting, on every
 * vault run, what every archives object was known to hold. That description is
 * the only record of it, and without it a later replacement is a blind
 * commitment.
 *
 * The origin is a column rather than a prefix on the path. Paths here are
 * relative to whatever remote root the environment names, so `vault/bitget/…`
 * and `sources/archives/bitget/…` both reduce to `bitget/…` — the thing that
 * once separated them is exactly the thing no longer stored.
 */
export const supersededPaths = (db: DatabaseSync, origin: Origin): string[] =>
  (db.prepare('SELECT DISTINCT remote FROM superseded WHERE origin = ?')
    .all(origin) as unknown as { remote: string }[]).map(row => row.remote);

/** Forget one, once its replacement has landed or its object has gone. */
export const resolveSuperseded = (db: DatabaseSync, origin: Origin, remote: string): void => {
  db.prepare('DELETE FROM superseded WHERE origin = ? AND remote = ?').run(origin, remote);
};

/** A part's members, with what they looked like when packed. */
export const membersWith = (db: DatabaseSync, partId: number): MemberRow[] =>
  db.prepare('SELECT path, bytes, mtime FROM member WHERE part_id = ? ORDER BY path')
    .all(partId) as unknown as MemberRow[];

/** A part's members, in the order they go into the tar. */
export const membersOf = (db: DatabaseSync, partId: number): string[] =>
  (db.prepare('SELECT path FROM member WHERE part_id = ? ORDER BY path')
    .all(partId) as unknown as { path: string }[]).map(row => row.path);

/** Per-venue rollup, for `cold stats`. */
export const byVenue = (db: DatabaseSync, origin: Origin): {
  venue: string; parts: number; bytes: number; months: number;
}[] => db.prepare(
  `SELECT venue, COUNT(*) AS parts, COALESCE(SUM(bytes), 0) AS bytes,
          COUNT(DISTINCT month) AS months
     FROM part WHERE origin = ?
    GROUP BY venue ORDER BY bytes DESC`,
).all(origin) as never;

// ── Internals ─────────────────────────────────────────────────────────────────

/** Handles already closed, so a second attempt is a no-op rather than a throw. */
const shut = new WeakSet<DatabaseSync>();

/**
 * `member` carries the partition's attributes alongside the path so a lookup —
 * "which parts hold this symbol's history" — is an index rather than a scan
 * that parses filenames. `variant` holds the extra levels verbatim, so a new
 * kind of extra needs no column.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS part (
  id          INTEGER PRIMARY KEY,
  origin      TEXT    NOT NULL,
  venue       TEXT    NOT NULL,
  month       TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  remote      TEXT    NOT NULL,
  local       TEXT    NOT NULL,
  bytes       INTEGER NOT NULL,
  files       INTEGER NOT NULL,
  planned_at  TEXT    NOT NULL,
  uploaded_at TEXT,
  handle      TEXT,
  -- Set when this part came from replanning a whole month whose members had
  -- already been packed. The comparison that guards a replacement is then
  -- month-wide and has already been made, so the per-part one must not be made
  -- again: bin packing moves a member between parts, and judging one part alone
  -- reads that move as a loss.
  replan      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (origin, venue, month, seq)
);

-- An object in Mega that a replan left behind: the month now packs into fewer
-- parts, so this name holds members that live elsewhere now. Recorded rather
-- than deleted, because nothing goes until its replacements are confirmed
-- uploaded and somebody says so.
CREATE TABLE IF NOT EXISTS ghost (
  origin   TEXT    NOT NULL,
  venue    TEXT    NOT NULL,
  month    TEXT    NOT NULL,
  remote   TEXT    NOT NULL,
  -- Permission, given once at the start of a run rather than earned per object.
  -- A backfill uploads for weeks, and an orphan is only removable after its
  -- replacements land; asking then means asking nobody, since the point of a
  -- long run is that it is left alone.
  approved INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (origin, remote)
);

CREATE TABLE IF NOT EXISTS member (
  part_id INTEGER NOT NULL REFERENCES part(id) ON DELETE CASCADE,
  path    TEXT    NOT NULL,
  bytes   INTEGER NOT NULL,
  mtime   INTEGER NOT NULL,
  venue   TEXT    NOT NULL,
  market  TEXT,
  symbol  TEXT,
  dataset TEXT,
  variant TEXT,
  month   TEXT    NOT NULL
);

/**
 * What a Mega object held, kept only while something is about to replace it.
 *
 * **A plan is discarded the moment its tar is missing, which is right — and it
 * takes with it the only description of what Mega holds at that path.** Without
 * this, replacing an object would be a blind commitment: no way to tell an
 * update that adds files from one that silently loses them.
 *
 * So before a plan is dropped, if Mega has its object, its members are copied
 * here. Rows survive a crash, which is the whole point of a table rather than a
 * map held for the run: an interruption between the drop and the upload would
 * otherwise leave the object with nothing describing it.
 *
 * They are deleted the moment they stop mattering — when the replacement is
 * confirmed in Mega, or when the object turns out to be gone. Nothing here is
 * kept for history.
 */
CREATE TABLE IF NOT EXISTS superseded (
  origin      TEXT    NOT NULL,
  remote      TEXT    NOT NULL,
  path        TEXT    NOT NULL,
  bytes       INTEGER NOT NULL,
  mtime       INTEGER NOT NULL,
  recorded_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS superseded_remote ON superseded (origin, remote);

CREATE TABLE IF NOT EXISTS month (
  origin    TEXT NOT NULL,
  venue     TEXT NOT NULL,
  month     TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  PRIMARY KEY (origin, venue, month)
);

CREATE INDEX IF NOT EXISTS member_part   ON member (part_id);
CREATE INDEX IF NOT EXISTS member_path   ON member (path);
CREATE INDEX IF NOT EXISTS member_lookup ON member (venue, market, symbol, month);
CREATE INDEX IF NOT EXISTS member_month  ON member (venue, month);
CREATE INDEX IF NOT EXISTS part_pending  ON part (origin, uploaded_at);
`;

/**
 * `member_part` is the one that is not optional.
 *
 * Every access to a single part's contents goes through `part_id` — reading a
 * member list before packing, deleting a stale plan, and SQLite's own cascade
 * when a part row goes. Without it each of those is a full scan of `member`,
 * which is 2.6 million rows: discarding 265 unpacked plans meant 265 scans,
 * around 700 million row visits, and a run that sat silent for minutes before
 * it could say it had started.
 *
 * A foreign key needs it doubly. `ON DELETE CASCADE` makes SQLite look for
 * children on every parent delete, and an unindexed child key turns that into a
 * scan whether or not the code deletes the rows itself.
 */

