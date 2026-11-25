import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { BREATH_MS, slice } from './serial';
import { inMemory } from './state';
import { inTransaction } from './tx';
import type { Edge, Held, Parked, Parking, Unsettled } from '../types';

/**
 * The backlog table, and the only code that touches it.
 *
 * **One owner, because the count has to be exact.** `wip` reaches tens of
 * millions of rows on a venue whose keys are constructed, and `count(*)` over
 * that is not a slow query but a stall: `node:sqlite` is synchronous, so a 1.8
 * second count freezes the whole process — every socket, every timer, every
 * other venue — and a count asked for on every poll would do that each time.
 *
 * A maintained counter holds only if nothing can change the table behind its
 * back. So the table is private to this file: everything else asks here, and
 * the count is kept as a consequence rather than as a duty.
 */

/**
 * Rows outstanding per venue, read once from the table and maintained after.
 *
 * **Seeded on first ask, not at startup.** The one real count is unavoidable —
 * nothing else can establish the starting point — but it is paid once per venue
 * per database, off whatever path happens to ask first, rather than on every
 * poll.
 *
 * **Held against the connection, not in a bare map.** A count describes one
 * database, and venue ids repeat across them: a figure keyed by venue alone
 * outlives the catalog it was read from and is then quietly wrong about the
 * next one. That is not only a test concern — a process that opens a second
 * catalog would inherit the first one's backlog — and it is the kind of wrong
 * that ends a drain early, since the drain stops when this reaches zero.
 */
const countsFor = (db: DatabaseSync): Map<number, number> => inMemory(db).parked;

/**
 * How many keys this venue still owes an answer for.
 *
 * Exact. A row leaves the backlog by being settled, given up on, or withdrawn,
 * and all three are deletions through this module — so nothing here is an
 * estimate, and `parked() === 0` is as trustworthy as the table itself.
 */
export const parked = (db: DatabaseSync, venueId: number): number => {
  const held = countsFor(db);
  const had  = held.get(venueId);

  if (had !== undefined) return had;

  const { n } = db.prepare('SELECT count(*) AS n FROM wip WHERE venue_id = ?')
    .get(venueId) as { n: number };

  held.set(venueId, n);

  return n;
};

/**
 * Whether anything is outstanding — asked of the table, never of the counter.
 *
 * **This is the question a pass ends on, so it is the one thing here that may
 * not be an optimisation.** `parked()` is a figure maintained in memory; this is
 * a fact. A counter can be wrong in a way nothing detects — it was, and a drain
 * that trusted it waited for ever on an empty backlog — and no amount of care in
 * maintaining it makes a memo a safe thing to end work on.
 *
 * **It costs an index probe.** `EXISTS` against `wip_next (venue_id, seq)` stops
 * at the first row, so it is the same work whether the venue owes one key or ten
 * million — which is what made `count(*)` unusable here and leaves this free.
 *
 * **A disagreement is repaired, not merely survived.** Where the table says
 * nothing is left and the counter says otherwise, the counter is wrong by
 * definition, and forgetting it makes the next read establish the truth: the
 * status endpoint stops reporting a backlog nobody has.
 */
export const anyParked = (db: DatabaseSync, venueId: number): boolean => {
  const owed = db.prepare('SELECT EXISTS (SELECT 1 FROM wip WHERE venue_id = ?) AS owed')
    .get(venueId) as { owed: number };

  if (owed.owed === 1) return true;

  if ((countsFor(db).get(venueId) ?? 0) > 0) recount(db, venueId);

  return false;
};

/**
 * Record what a batch did to the backlog.
 *
 * **Called after the commit, never inside it.** A transaction that rolls back
 * did nothing to the table, and a counter moved before the commit would keep the
 * change anyway — silently, and for the life of the process. The drain stops on
 * this number reaching zero, so a counter that drifts high never finishes a pass
 * and one that drifts low ends it with rows still owed.
 */
export const counted = (db: DatabaseSync, venueId: number, delta: number): void => {
  if (delta === 0) return;

  const held = countsFor(db);
  const had  = held.get(venueId);

  // Nothing has asked yet, so there is no figure to correct: the first read
  // will count the table as it now stands, this change included.
  if (had === undefined) return;

  held.set(venueId, Math.max(0, had + delta));
};

/** Forget what is held, so the next read establishes it from the table again. */
export const recount = (db: DatabaseSync, venueId?: number): void => {
  const held = countsFor(db);

  if (venueId === undefined) held.clear();
  else held.delete(venueId);
};


// ── Reading ───────────────────────────────────────────────────────────────────

/**
 * Keys whose metadata nobody has established yet, oldest first by arrival.
 *
 * `seq` is the keyset, passed back as `after` to continue. That is a cursor by
 * value rather than an open statement: SQLite will let a query step while the
 * same connection rewrites the rows it is walking, and what happens then depends
 * on which index the planner chose — rows visited twice, or not at all, with
 * nothing said. A keyset cannot be wrong that way, and it survives a restart.
 */
export const next = (
  db:      DatabaseSync,
  venueId: number,
  after:   number,
  limit:   number,
): Unsettled[] =>
  (db.prepare(
    `SELECT seq, venue_id, path, date, tries, series_id, existence, next_part FROM wip
      WHERE venue_id = ? AND seq > ?
      ORDER BY seq
      LIMIT ?`,
  ).all(venueId, after ?? 0, limit) as unknown as {
    seq: number; venue_id: number; path: string; date: string; tries: number;
    series_id: number; existence: string; next_part: string | null;
  }[]).map(row => ({
    seq:      row.seq,
    venueId:  row.venue_id, path: row.path, date: row.date, tries: row.tries,
    seriesId: row.series_id, existence: row.existence as Unsettled['existence'],
    ...(row.next_part ? { nextPart: row.next_part } : {}),
  }));


// ── Writing, where this module owns the transaction ───────────────────────────

/**
 * **Nothing is parked that the catalog already holds.**
 *
 * Generation reads the tip and nothing else, so an update re-emits every key in
 * the patience window whether or not its file arrived days ago, which on a venue
 * that publishes promptly is most of them. Probing those again
 * cannot change anything either, since settling acts only on parked rows and
 * inserts `ON CONFLICT DO NOTHING`, so a held file is never corrected by an
 * update; a correction goes through `correctFile`.
 *
 * So the question is asked here, at the one moment the row is still cheap not to
 * write: one index probe against `file`'s primary key, against an insert, a read
 * and a request later on. What is left parked is what the window is for — the
 * periods nobody has answered for yet.
 *
 * **A withdrawn file is not a held one.** Its row stays as the record that the
 * venue once served it, and `existence <> 'absent'` is what lets a later pass
 * ask whether it is back.
 */
const PARKING = `
  INSERT INTO wip (venue_id, path, date, series_id, existence, created_at, next_part)
       SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM file
                           WHERE venue_id = ? AND path = ? AND existence <> 'absent')
     ON CONFLICT (venue_id, path) DO NOTHING`;

/** The same rule, for the findings a walk parks with what it already learned. */
const PARKING_SEEN = `
  INSERT INTO wip (venue_id, path, date, size, etag, modified, series_id,
                   existence, created_at, next_part)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM file
                           WHERE venue_id = ? AND path = ? AND existence <> 'absent')
     ON CONFLICT (venue_id, path) DO NOTHING`;

/**
 * Park keys nothing has answered for yet.
 *
 * `DO NOTHING` rather than an upsert, so `changes` says exactly how many rows
 * are new — which is what the counter needs and what an upsert cannot report,
 * since SQLite counts an update as a change too.
 */
export const park = (db: DatabaseSync, rows: readonly Parking[]): number => {
  if (rows.length === 0) return 0;

  const at = new Date().toISOString();

  const insert = db.prepare(
    PARKING,
  );

  const added = new Map<number, number>();

  inTransaction(db, () => {
    for (const row of rows) {
      const done = insert.run(row.venueId, row.path, row.date, row.seriesId, row.existence, at,
        row.nextPart ?? null, row.venueId, row.path);

      if (Number(done.changes) > 0)
        added.set(row.venueId, (added.get(row.venueId) ?? 0) + 1);
    }
  });

  for (const [venueId, delta] of added) counted(db, venueId, delta);

  return rows.length;
};

/** Rows nobody is going to settle, so they stop being offered. */
export const drop = (db: DatabaseSync, rows: readonly Unsettled[]): number => {
  if (rows.length === 0) return 0;

  const remove = db.prepare('DELETE FROM wip WHERE venue_id = ? AND path = ?');
  const gone   = new Map<number, number>();

  inTransaction(db, () => {
    for (const row of rows) {
      const done = remove.run(row.venueId, row.path);

      if (Number(done.changes) > 0) gone.set(row.venueId, (gone.get(row.venueId) ?? 0) - 1);
    }
  });

  for (const [venueId, delta] of gone) counted(db, venueId, delta);

  return rows.length;
};

/**
 * Record that these rows were asked about and did not settle.
 *
 * One transaction, because a pass that counted its attempts and then died
 * half-way would give some rows a free retry and not others. Nothing leaves the
 * backlog, so the count is untouched.
 */
export const missed = (db: DatabaseSync, rows: readonly Unsettled[]): number => {
  if (rows.length === 0) return 0;

  const bump = db.prepare('UPDATE wip SET tries = tries + 1 WHERE venue_id = ? AND path = ?');

  inTransaction(db, () => {
    for (const row of rows) bump.run(row.venueId, row.path);
  });

  return rows.length;
};

/**
 * Delete a series' backlog rows dated after `date`.
 *
 * **Here, because the table is this module's.** Whoever decides that nothing
 * above a date is worth asking keeps that rule; the delete happens here, where
 * the counter sees it.
 */
export const dropAbove = (
  db:       DatabaseSync,
  venueId:  number,
  seriesId: number,
  date:     string,
): number => {
  const done = db.prepare('DELETE FROM wip WHERE series_id = ? AND date > ?').run(seriesId, date);
  const gone = Number(done.changes);

  counted(db, venueId, -gone);

  return gone;
};


// ── Writing, where the caller owns a transaction spanning `file` too ──────────

/**
 * The statements a caller needs when its transaction covers `file` as well.
 *
 * **Handed out rather than wrapped, because the atomicity is the caller's.**
 * `putFiles` and `settleFiles` write both tables in one transaction so a file
 * cannot arrive without leaving the backlog; splitting that across two modules'
 * transactions would put a crash between them.
 *
 * Each returns the row delta, and the caller adds them up and reports the total
 * to `counted` **after** its commit — so a rollback costs nothing and the
 * counter never describes a write that did not happen.
 */
export const writer = (db: DatabaseSync): {
  park:   (row: Parked) => number;
  unpark: (venueId: number, path: string) => number;
  take:   (venueId: number, path: string) => string | null;
  learn:  (size: number | null, etag: string | null, modified: string | null,
           existence: string | null, venueId: number, path: string) => void;
  held:   (venueId: number, path: string) => Held | undefined;
} => {
  /** **Nothing is parked that the catalog already holds** — see `PARKING`. */
  const insert: StatementSync = db.prepare(
    PARKING_SEEN,
  );

  /**
   * What a key offered again while parked updates, as its own statement.
   *
   * `existence` is left alone: a ruling somebody made survives the venue going
   * on offering the key, which it will on every walk. So is `seq` — re-offering
   * a key must not move it to the back of the queue, or a venue that re-lists
   * the same names every walk would keep pushing its own backlog out of reach of
   * the sweep reading it. So is `created_at`: it is when the key was first
   * sighted, which is what the file's `seen_at` becomes once it arrives.
   */
  const refresh: StatementSync = db.prepare(
    `UPDATE wip
        SET date       = ?,
            series_id  = COALESCE(?, series_id),
            size       = COALESCE(?, size),
            etag       = COALESCE(?, etag),
            modified   = COALESCE(?, modified)
      WHERE venue_id = ? AND path = ?`,
  );

  const remove: StatementSync = db.prepare(
    'DELETE FROM wip WHERE venue_id = ? AND path = ? RETURNING created_at AS seenAt',
  );

  const learned: StatementSync = db.prepare(
    `UPDATE wip
        SET size      = COALESCE(?, size),
            etag      = COALESCE(?, etag),
            modified  = COALESCE(?, modified),
            existence = COALESCE(?, existence)
      WHERE venue_id = ? AND path = ?`,
  );

  const one: StatementSync = db.prepare(
    `SELECT date, size, etag, modified, series_id AS seriesId, created_at AS seenAt
       FROM wip WHERE venue_id = ? AND path = ?`,
  );

  return {
    park: (row) => {
      /**
       * **Nothing to ask next**, and a walk never has anything: it is handed
       * every part there is, so nothing it parks has to imply what follows it. A
       * token is carried only where a key was generated — see `park`.
       */
      const done = insert.run(row.venueId, row.path, row.date, row.size, row.etag,
        row.modified, row.seriesId, row.existence, row.seenAt, null, row.venueId, row.path);

      if (Number(done.changes) > 0) return 1;

      refresh.run(row.date, row.seriesId, row.size, row.etag, row.modified,
        row.venueId, row.path);

      return 0;
    },

    unpark: (venueId, path) => (remove.get(venueId, path) ? -1 : 0),

    /**
     * Unpark a key the catalog is about to receive, handing back when it was
     * first sighted, or null where it was not parked. Wherever this returns a
     * time, the row delta is -1.
     */
    take: (venueId, path) =>
      (remove.get(venueId, path) as { seenAt: string } | undefined)?.seenAt ?? null,

    learn: (size, etag, modified, existence, venueId, path) =>
      void learned.run(size, etag, modified, existence, venueId, path),

    held: (venueId, path) => one.get(venueId, path) as Held | undefined,
  };
};

/**
 * The parked paths between two edges — what a walked page checks against what it
 * offered, so a key the venue dropped before anyone probed it leaves the queue
 * rather than being asked about for ever. See `putFiles`.
 */
export const pathsIn = (db: DatabaseSync, venueId: number, from: Edge, to: Edge): string[] =>
  (db.prepare(
    `SELECT path FROM wip
      WHERE venue_id = ? AND path ${from.open ? '>' : '>='} ? AND path ${to.open ? '<' : '<='} ?`,
  ).all(venueId, from.path, to.path) as { path: string }[]).map(row => row.path);


// ── Parking in batches ────────────────────────────────────────────────────────

/**
 * Park keys, letting several callers share one transaction.
 *
 * **Generation writes nothing but backlog rows.** A generated key carries no
 * size and no etag, so it can never be `ready` — `putFiles` takes every one of
 * them down the parking branch and touches neither `file` nor a partition.
 * What it does do is spend a slice on each page, and an update's page is a
 * single series: sixteen rows or so, for one turn of the event loop apiece.
 * Every venue generating at once shares that queue, so the whole catalog's
 * generation ran at the rate slices could be taken.
 *
 * So the rows wait here instead, and go down in one transaction when there are
 * enough of them or one has waited long enough. Draining already worked this
 * way — that is the whole of why a venue drained faster than it generated.
 *
 * **The promise still means committed.** A caller awaits its own rows reaching
 * disk exactly as it awaited `putFiles`, so a cursor still advances only over
 * work that is written, and a failed flush rejects every caller sharing it.
 */
export const parkSoon = async (db: DatabaseSync, rows: readonly Parking[]): Promise<number> => {
  if (rows.length === 0) return 0;

  const held = inMemory(db).parking;

  held.rows.push(...rows);

  const mine = new Promise<number>((ok, no) => held.waiting.push({ ok, no }));

  if (held.rows.length >= FLUSH_ROWS) void flush(db);
  else if (! held.timer) held.timer = setTimeout(() => void flush(db), FLUSH_MS);

  return mine;
};

/**
 * Write what is waiting, now.
 *
 * **Synchronous, because the one caller that cannot wait is the exit.** A signal
 * handler has no turn of the loop left to give, so this writes directly rather
 * than through the queue — joining an open transaction if a slice is mid-write,
 * exactly as `flushTips` does.
 *
 * Losing this costs a pass rather than data: the keys would be generated again
 * by the next update, since nothing lifts a tip until a pass completes. It is
 * still worth doing and not worth blocking an exit for.
 */
export const flushParked = (db: DatabaseSync): number => {
  const held = inMemory(db).parking;

  if (held.rows.length === 0) return 0;

  if (held.timer) { clearTimeout(held.timer); held.timer = null; }

  const rows    = held.rows.splice(0, held.rows.length);
  const waiting = held.waiting.splice(0, held.waiting.length);

  try {
    // No budget here: the exit has no later turn to finish in.
    const { added, joined } = write(db, rows, 0, Infinity);

    /**
     * **Only where this owns nothing.** `write` counts the transaction it
     * commits itself; joined to somebody else's, the rows are not committed yet
     * and the count belongs after that caller's commit. This is the exit path,
     * where the process ends before either figure is read again.
     */
    if (joined) for (const [venueId, delta] of added) counted(db, venueId, delta);

    for (const one of waiting) one.ok(rows.length);
  } catch (err) {
    for (const one of waiting) one.no(err);

    throw err;
  }

  return rows.length;
};


// ── Internals ─────────────────────────────────────────────────────────────────

/** How many rows are worth a transaction of their own. */
const FLUSH_ROWS = 2_000;

/**
 * How long a row waits for company.
 *
 * Short enough that a venue generating alone is not held up — its page lands a
 * few milliseconds later than it would have — and long enough that the lanes of
 * several venues, which arrive within a turn of each other, go down together.
 */
const FLUSH_MS = 25;

/**
 * Take everything waiting and write it.
 *
 * **In slices bounded by time, never in one transaction.** `node:sqlite` is
 * synchronous: a batch written in one go holds the event loop for as long as the
 * insert takes, and against a backlog of tens of millions with a unique index
 * over it that is long enough for every probe lane in the process to fall idle
 * waiting for its own response to be read. Batching the rows is what saves the
 * queue turns; writing them without a bound is how the turn that remains lasts
 * for seconds.
 *
 * So the same rule `putFiles` follows applies here — `BREATH_MS` of writing,
 * then the loop back — and the batching still pays, because a slice now carries
 * however many rows fit in its budget instead of one page's sixteen.
 */
const flush = async (db: DatabaseSync): Promise<void> => {
  const held = inMemory(db).parking;

  if (held.rows.length === 0) return;

  if (held.timer) { clearTimeout(held.timer); held.timer = null; }

  const rows    = held.rows.splice(0, held.rows.length);
  const waiting = held.waiting.splice(0, held.waiting.length);

  try {
    let at = 0;

    /** Each slice counts its own commit — see `write`. Nothing is carried here. */
    while (at < rows.length)
      at = (await slice(() => write(db, rows, at, Date.now() + BREATH_MS))).upto;

    for (const one of waiting) one.ok(rows.length);
  } catch (err) {
    for (const one of waiting) one.no(err);
  }
};

/**
 * The write itself, which both flushes share.
 *
 * `DO NOTHING` rather than an upsert, so `changes` says exactly how many rows
 * are new — an upsert reports an update as a change too, and the count would
 * drift by every key a venue offered twice.
 *
 * A transaction already open is joined rather than refused, and `joined` says
 * whether it was.
 */
const write = (
  db:     DatabaseSync,
  rows:   readonly Parking[],
  from:   number,
  until:  number,
): { upto: number; added: Map<number, number>; joined: boolean } => {
  const at = new Date().toISOString();

  const insert = db.prepare(
    PARKING,
  );

  const added  = new Map<number, number>();
  const joined = db.isTransaction;

  let upto = from;

  inTransaction(db, () => {
    /**
     * **At least one row, then as many as the budget allows.** Stopping on the
     * clock alone could write nothing at all on a loaded machine, and a slice
     * that makes no progress is a spin rather than a pause.
     */
    for (; upto < rows.length && (upto === from || Date.now() < until); upto++) {
      const row  = rows[upto]!;
      const done = insert.run(row.venueId, row.path, row.date, row.seriesId, row.existence, at,
        row.nextPart ?? null, row.venueId, row.path);

      if (Number(done.changes) > 0) added.set(row.venueId, (added.get(row.venueId) ?? 0) + 1);
    }
  }, { join: true });

  /**
   * **Counted here, in the same synchronous span as the commit that earned
   * it, because returning yields.** `slice` awaits a `setImmediate` after every
   * slice, and the probe settles rows in that gap: it reads what this
   * transaction just committed, deletes it and reports `-n`. `counted` clamps at
   * zero, so a decrement that reached the counter before its `+n` would be
   * discarded and the counter would stay high for good. From the commit to the
   * count there is no await, so a decrement cannot precede its increment.
   *
   * Joined to a caller's transaction, nothing is committed yet: the count is the
   * caller's to apply after its own commit.
   */
  if (! joined) for (const [venueId, delta] of added) counted(db, venueId, delta);

  return { upto, added, joined };
};
