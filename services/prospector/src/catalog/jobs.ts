import type { DatabaseSync } from 'node:sqlite';
import { byteOrder, ceiling } from '../paths';
import { inTransaction } from './tx';
import type { Run, RunKind } from '../types';

/**
 * Jobs and their partitions: the `run` rows that say what a pass over a venue
 * set out to read, how far each part of it got, and what it cost.
 *
 * A **job** is one pass over a venue: the run at the empty scope, plus one run
 * per partition, all created together. What has been done is read back from
 * these rows rather than held anywhere else, so a pass interrupted at any point
 * resumes from them.
 */

/**
 * When the venue's unfinished update began, or null if it has none.
 *
 * **Rows of kind `update` existing at all is the signal.** Generation records
 * itself one series at a time — a partition per series, closed when its keys are
 * written — and they are cleared as the last act of a pass that reconciled. So
 * a venue with update rows is a venue whose pass did not get that far, and
 * there is nothing else to look up.
 *
 * Probing needs no equivalent, because `wip` *is* its progress: a key is on the
 * list until it is answered, and a restart picks up exactly what is left.
 */
export const updateStarted = (db: DatabaseSync, venueId: number): string | null => {
  const row = db.prepare(
    `SELECT MIN(started) AS started FROM run
      WHERE venue_id = ? AND kind = 'update' AND scope <> ''`,
  ).get(venueId) as { started: string | null };

  return row.started;
};

/**
 * Throw away a venue's update progress, so the next pass plans a fresh one.
 *
 * **Reconciliation's last act, and the only thing that ends a pass.** Everything
 * before it is resumable: the preamble has run, the scopes are planned, the
 * finished series are recorded, and the queue holds what is left. Once the tips
 * have been settled there is nothing about the pass worth keeping.
 *
 * **The per-series rows go; the job row is closed and kept.** `run` is a
 * progress table rather than a log, and a venue's pass adds one row per series —
 * tens of thousands on a large venue. Keeping those to record that a pass happened
 * would grow the table by that much every day for a fact one row already states.
 * The job row is that one row: it carries the pass's start, end and totals,
 * costs nothing, and cannot be mistaken for work outstanding because progress is
 * read from the partitions.
 *
 * Also how an expired pass is discarded. A pass older than the interval between
 * passes is not one to continue — its scopes were chosen against tips that have
 * since moved — so its partitions go and the venue plans again.
 */
export const clearUpdate = (db: DatabaseSync, venueId: number): number => {
  const done = db.prepare(
    `DELETE FROM run WHERE venue_id = ? AND kind = 'update' AND scope <> ''`,
  ).run(venueId);

  db.prepare(
    `UPDATE run SET completed = ?
      WHERE venue_id = ? AND kind = 'update' AND scope = '' AND completed IS NULL`,
  ).run(new Date().toISOString(), venueId);

  return Number(done.changes);
};

/**
 * Close a walk whose drain has finished.
 *
 * **The counterpart of `clearUpdate`, and for the same reason.** A pass that
 * parked keys for probing is not over when the listing ends: the job is the only
 * durable record that the backlog is owed, so it stays open until the drain
 * returns and is closed here. A walk over a venue that states everything in its
 * listing never reaches this — `surveyVenue` closes that one itself, where it
 * genuinely does end.
 *
 * **Only the root scope**, because the partitions closed as they finished. It is
 * the `scope = ''` row that `enrolment` reads to say a job is open, and the one
 * a resume would carry on from.
 */
export const closeWalk = (db: DatabaseSync, venueId: number): void => {
  db.prepare(
    `UPDATE run SET completed = ?, cursor = NULL
      WHERE venue_id = ? AND kind = 'walk' AND scope = '' AND completed IS NULL`,
  ).run(new Date().toISOString(), venueId);
};

/**
 * How many findings the open job has produced so far.
 *
 * **The producer's own count, not a count of what is left.** Whichever half is
 * producing — a walk cataloguing what an index offered, a generator building
 * keys from a pattern — writes its page total onto its partition as it goes, so
 * the sum is already on disk and costs a scan of a table with thousands of rows
 * rather than millions.
 *
 * It is what makes a probe's progress readable. "Settled 96,000" says nothing
 * about whether that is nearly all of it or a tenth of it, and the difference is
 * the only question somebody watching the logs has. Against the number produced
 * it says both, and the gap between them says whether the probe is keeping up.
 *
 * Scoped to the open job, because a completed one is not what is being watched
 * and its partitions are still on record.
 */
export const producedSoFar = (db: DatabaseSync, venueId: number, kind: RunKind): number | null => {
  const job = openJob(db, venueId, kind);

  if (! job) return null;

  const row = db.prepare(
    `SELECT COALESCE(SUM(found), 0) AS found FROM run
      WHERE venue_id = ? AND kind = ? AND started = ?`,
  ).get(venueId, kind, job.started) as { found: number };

  return row.found;
};

/**
 * The job a venue is in the middle of, or null if it is between jobs.
 *
 * A **job** is one pass over a venue: the run at the empty scope, plus one run
 * per partition, all created together. The empty-scope run is the job — while it
 * is open, there is work outstanding, and it is the only thing anyone has to ask
 * about to know that.
 *
 * There is no separate notion of a first pass. A first pass is a job with no
 * predecessor; a refresh is a job whose predecessor's rows were dropped first.
 * Same rows, same walk.
 */
export const openJob = (db: DatabaseSync, venueId: number, kind: RunKind): Run | null => {
  const row = db.prepare(
    `SELECT * FROM run WHERE venue_id = ? AND kind = ? AND scope = '' AND completed IS NULL`,
  ).get(venueId, kind) as RunRow | undefined;

  return row ? rowToRun(row) : null;
};

/**
 * Start a job: the job row and every partition, **in one transaction**.
 *
 * Atomicity is the whole point. Once a job is resumed by reading its open
 * partitions back, those rows *are* the work — so a crash part-way through
 * creating them would leave a partial set that looks exactly like a finished
 * one, and the partitions never written would be silently skipped. Committing
 * the job row alongside them means an open job always has its complete set.
 *
 * Every row shares one `started`, so the whole job carries a single epoch: what
 * a partition claims is the archive as it was when the *job* began, not when its
 * own walk happened to start hours later. That is the more conservative claim
 * and the one the cascade wants.
 */
export const beginJob = (
  db:      DatabaseSync,
  venueId: number,
  kind:    RunKind,
  scopes:  readonly string[],
): Run => {
  // The job occupies the empty scope, so a partition cannot also be empty
  // without colliding with it: the venue root as a whole is the job, never one
  // of its partitions.
  if (scopes.some(scope => scope === ''))
    throw new Error('A partition cannot be the empty scope: that is the job itself');

  const started = new Date().toISOString();
  const insert  = db.prepare(
    `INSERT INTO run (venue_id, kind, scope, cursor, started) VALUES (?, ?, ?, NULL, ?)`,
  );

  inTransaction(db, () => {
    insert.run(venueId, kind, '', started);

    for (const scope of scopes) insert.run(venueId, kind, scope, started);
  });

  return openJob(db, venueId, kind)!;
};

/**
 * The partitions of the open job that still have keyspace nobody has read.
 *
 * This is the work list, read rather than re-derived. A partition disappears
 * from it by being walked to exhaustion, so resuming needs no notion of what has
 * already been done — what is left is what is here.
 *
 * The cursor rides along, which is what makes an interrupted walk continue
 * rather than restart. A run is hours long and will be interrupted, so it lives
 * in the database rather than in memory.
 */
export const openPartitions = (db: DatabaseSync, venueId: number, kind: RunKind): Run[] =>
  (db.prepare(
    `SELECT * FROM run
      WHERE venue_id = ? AND kind = ? AND scope != '' AND completed IS NULL
      ORDER BY id`,
  ).all(venueId, kind) as unknown as RunRow[]).map(rowToRun);

/** Move a run's cursor and its counters. Called once per page. */
export const advanceRun = (
  db:       DatabaseSync,
  runId:    number,
  cursor:   string | null,
  requests: number,
  found:    number,
): void => {
  db.prepare(
    `UPDATE run SET cursor = ?, requests = requests + ?, found = found + ? WHERE id = ?`,
  ).run(cursor, requests, found, runId);
};

/**
 * Add what a venue was asked and what that sent to the job it has open. Says
 * whether one was open.
 *
 * **The newest open job, whichever kind.** Only one is open in ordinary life;
 * an update forced over an unfinished walk leaves both, and what goes out from
 * then on is the update's.
 */
export const addCounts = (
  db:      DatabaseSync,
  venueId: number,
  asked:   number,
  sent:    number,
): boolean => {
  const done = db.prepare(
    `UPDATE run SET asked = asked + ?, sent = sent + ?
      WHERE id = (SELECT id FROM run
                   WHERE venue_id = ? AND scope = '' AND completed IS NULL
                   ORDER BY started DESC, id DESC LIMIT 1)`,
  ).run(asked, sent, venueId);

  return Number(done.changes) > 0;
};

/**
 * Close a run, clearing its cursor — the scope was walked to exhaustion, so
 * there is no position left to resume from.
 */
export const closeRun = (db: DatabaseSync, runId: number): void => {
  db.prepare('UPDATE run SET completed = ?, cursor = NULL WHERE id = ?')
    .run(new Date().toISOString(), runId);
};

/**
 * Replace one partition with its children, in a single transaction.
 *
 * **The whole risk of dynamic scoping lives in this function**, which is why it
 * is the only thing allowed to create or destroy a partition inside an open job.
 * A parent removed without its children written is a stretch of keyspace
 * belonging to nothing — a hole that no later pass would notice, because the
 * work list is the partitions and the partitions no longer mention it.
 *
 * Children inherit the parent's `started`, because the job's epoch is what every
 * partition's claim rests on: a partition walked later still promises the
 * archive as it was when the job began, and a child inventing its own timestamp
 * would quietly promise more than that.
 *
 * **The cursor is divided by where it falls, not carried by all of them.** A
 * walk is ordered, so a child sorting entirely below the cursor has been read
 * already and is not recreated at all; the one containing it resumes from it;
 * the rest start fresh. `progress` says which is which.
 */
export const refinePartition = (
  db:       DatabaseSync,
  parent:   Run,
  children: readonly string[],
): Run[] => {
  const insert = db.prepare(
    `INSERT INTO run (venue_id, kind, scope, cursor, started) VALUES (?, ?, ?, ?, ?)`,
  );

  const wanted = progress(parent.cursor, children);

  inTransaction(db, () => {
    // Closed rather than deleted: what a partition read is part of the job's
    // history, and its `requests` and `found` still count towards the pass.
    db.prepare('UPDATE run SET completed = ?, cursor = NULL WHERE id = ?')
      .run(new Date().toISOString(), parent.id);

    for (const [scope, cursor] of wanted)
      insert.run(parent.venueId, parent.kind, scope, cursor, parent.started);
  });

  return openPartitions(db, parent.venueId, parent.kind)
    .filter(run => wanted.some(([scope]) => scope === run.scope));
};

/**
 * Throw away a venue's progress so the next survey starts from nothing.
 *
 * **The one destructive thing the API can ask for, and only ever on request.**
 * A reset is not a kind of survey: it is the step before one, and it exists so
 * that asking a busy venue to survey can never silently discard a backfill.
 *
 * Series and files are untouched. What a venue published is a measurement and
 * stays true; what is dropped is only the record of how far this service had
 * read, which is what makes the next pass start at the beginning.
 */
export const resetRuns = (db: DatabaseSync, venueId: number): number => {
  const gone = db.prepare('DELETE FROM run WHERE venue_id = ?').run(venueId);

  return Number(gone.changes);
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Which children still have keyspace to read, and from where.
 *
 * A prefix covers everything from itself up to its `ceiling` — the prefix with
 * its last character incremented — so a cursor at or past that ceiling means the
 * whole child has been walked. Below the child's own start, nothing of it has.
 *
 * **Judged in byte order**, the order the walk reads in: compared by UTF-16
 * units, a child past the Basic Multilingual Plane would sort below a sibling
 * it follows, and be taken for read when nothing of it has been.
 */
const progress = (
  cursor:   string | null,
  children: readonly string[],
): [string, string | null][] => {
  if (cursor === null) return children.map(scope => [scope, null]);

  const out: [string, string | null][] = [];

  for (const scope of children) {
    if (byteOrder(cursor, ceiling(scope)) >= 0) continue;              // wholly read

    out.push([scope, byteOrder(cursor, scope) >= 0 ? cursor : null]);  // resumes, or fresh
  }

  return out;
};

interface RunRow {
  id:        number;
  venue_id:  number;
  kind:      string;
  scope:     string;
  cursor:    string | null;
  requests:  number;
  found:     number;
  asked:     number;
  sent:      number;
  started:   string;
  completed: string | null;
}

const rowToRun = (row: RunRow): Run => ({
  id:        row.id,
  venueId:   row.venue_id,
  kind:      row.kind as RunKind,
  scope:     row.scope,
  cursor:    row.cursor,
  requests:  row.requests,
  found:     row.found,
  asked:     row.asked,
  sent:      row.sent,
  started:   row.started,
  completed: row.completed,
});
