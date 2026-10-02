import type { DatabaseSync } from 'node:sqlite';
import * as cache from './cache/months';
import * as wip from './wip';
import { BREATH_MS, slice } from './serial';
import { ceiling } from '../paths';
import { sawFile } from './series';
import type { CatalogFile, LastRun, Existence, FileEffect, FileState, Parking, Phase, Run, RunKind, Settlement, Standing, Unreadable, Unsettled, VenueTotals } from '../types';

/**
 * Every write and read the catalog supports, as prepared statements over one
 * open database. Nothing else in either service writes SQL.
 *
 * The queries are shaped around two access patterns and no others: **insert a
 * page of discovered files**, and **ask what is known for a venue, a date range
 * and a path prefix**. Anything that needs a different shape needs a new
 * function here rather than a query written at the call site, so the indexes
 * that make it fast stay next to the statements that need them.
 */

/** Register a venue, or update where it is served from. Returns its id. */
export const putVenue = (
  db:   DatabaseSync,
  name: string,
  base: string,
  keyRoot: string,
  host: string = '',
): number => {
  db.prepare(
    `INSERT INTO venue (name, host, base, key_root) VALUES (?, ?, ?, ?)
       ON CONFLICT (name, host) DO UPDATE SET base = excluded.base, key_root = excluded.key_root`,
  ).run(name, host, base, keyRoot);

  const row = db.prepare('SELECT id FROM venue WHERE name = ? AND host = ?')
    .get(name, host) as { id: number };

  return row.id;
};

/**
 * Every id a venue answers to.
 *
 * A venue served by two hosts is two rows, so anything asking about the venue
 * as a whole — how much of it is catalogued, what it published in a month —
 * wants `venue_id IN (…)` rather than a single id. One host is the ordinary
 * case and returns one id, so callers need no special path for it.
 */
export const venueIds = (db: DatabaseSync, name: string): number[] =>
  (db.prepare('SELECT id FROM venue WHERE name = ? ORDER BY host').all(name) as { id: number }[])
    .map(row => row.id);

/**
 * Record a page of files, as one transaction.
 *
 * Batched deliberately rather than written row by row: the transaction is what
 * makes a hundred thousand inserts take under a second, and keeping each batch
 * short is what stops a long walk holding the write lock against anyone else.
 *
 * Three things happen to a key seen again:
 *
 * - `seen_at` is left alone. It is first discovery, and answers "when did we
 *   first learn this existed" — a question whose answer must not drift.
 * - `last_seen` moves, which is what later lets a re-walk notice a withdrawal.
 * - If size, etag or the venue's `modified` differ, the new version becomes
 *   current **and the observation is appended to `revision`**, so a consumer can
 *   ask what changed since it last looked rather than being told only that
 *   something did.
 */
export const putFiles = async (
  db:     DatabaseSync,
  files:  readonly CatalogFile[],

): Promise<number> => {
  if (files.length === 0) return 0;

  const current = db.prepare(
    `SELECT series_id AS seriesId, date, size, etag, modified, existence, downloaded_at AS downloadedAt
       FROM file WHERE venue_id = ? AND path = ?`,
  );

  /**
   * **The trail holds the version being replaced, with the download state it
   * had at that moment.**
   *
   * That is what makes the history answer a question worth asking: not merely
   * "this file changed once", but "the version I built from is no longer the one
   * published, and I did hold it". `seen_at` is when the change was observed,
   * which is the same instant either way — what it carries is the *outgoing*
   * version, not the incoming one, since the incoming one is in `file`.
   */
  const revise = db.prepare(
    `INSERT INTO revision (venue_id, path, seen_at, size, etag, modified, downloaded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue_id, path, seen_at) DO NOTHING`,
  );

  /**
   * **A sighting that does not state a field leaves what is known.** An HTML
   * index names files and says nothing about them, so a walk of one carries
   * three nulls — and writing those over what a probe established would undo
   * hours of work on every refresh and send it round again from nothing. A
   * listing venue states all three every time, so `COALESCE` never fires there.
   *
   * `downloaded_at` is bound rather than coalesced, because it is the one field
   * a change must *clear*: a new version has not been downloaded, whatever was
   * true of the last one. Clearing it here is the whole of "pending again" —
   * there is no second write to forget.
   */
  const insert = db.prepare(
    `INSERT INTO file (venue_id, path, date, size, etag, modified, existence,
                       series_id, seen_at, last_seen, downloaded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue_id, path) DO UPDATE SET
          date          = excluded.date,
          -- Learned once and kept: a sighting that cannot name a series is not
          -- a statement that the file has none.
          series_id     = COALESCE(excluded.series_id, file.series_id),
          size          = COALESCE(excluded.size, file.size),
          etag          = COALESCE(excluded.etag, file.etag),
          modified      = COALESCE(excluded.modified, file.modified),
          existence     = excluded.existence,
          last_seen     = excluded.last_seen,
          downloaded_at = excluded.downloaded_at`,
  );

  const seen = db.prepare(
    `UPDATE file SET last_seen = ? WHERE venue_id = ? AND path = ?`,
  );

  /**
   * **The backlog is not this function's table.** A finding a walk could say
   * nothing about is parked until a probe can, and one that arrived complete has
   * no business still being parked — both through `wip`, which owns those
   * statements and keeps the count they move. What stays here is the
   * transaction: a file must not arrive without leaving the backlog, so the two
   * tables are written together and the deltas are reported once it commits.
   */
  const backlog = wip.writer(db);

  /**
   * **Written in short transactions with the thread handed back between them.**
   *
   * `node:sqlite` is synchronous, so a page written in one go holds the event
   * loop for as long as the write takes — and a page is thousands of statements.
   * Nothing else in the process runs meanwhile: not a timer, not a socket. With
   * many partitions in flight the loop spends its life inside this function, and
   * anything that needs several turns to finish — a response body arriving in
   * chunks — advances one chunk per write and effectively stops.
   *
   * So the work is cut by the clock rather than by a row count, since what
   * matters is the length of the pause and not the number of rows behind it.
   * Each slice is committed before the loop is released, so a slice is still
   * atomic and still cannot interleave with another partition's: there is no
   * `await` between `BEGIN` and `COMMIT`.
   *
   * **A page is no longer atomic, and does not need to be.** Its cursor advances
   * only after the last slice, so an interruption re-lists the page and rewrites
   * it — and every write here is an upsert keyed by path, so writing it twice
   * says exactly what writing it once said.
   */
  for (let at = 0; at < files.length;) {
    const { sighted } = await slice(() => {
      const until = Date.now() + BREATH_MS;

      /**
       * **Every file that arrived.** A sighting is "this file exists, and it is
       * this old and this new", which is the whole of what a per-file writer can
       * say. Nothing here touches a tip: what a tip claims is that a *range* was
       * asked about, and no single file is evidence of that.
       */
      const sighted: { seriesId: number; date: string }[] = [];

      /** What this slice moved in the backlog, reported once it has committed. */
      const parked = new Map<number, number>();

      const moved = (venueId: number, delta: number): void => {
        if (delta !== 0) parked.set(venueId, (parked.get(venueId) ?? 0) + delta);
      };

      db.exec('BEGIN');

      try {
        const effects: FileEffect[] = [];

        for (; at < files.length && Date.now() < until; at++) {
          const file = files[at]!;
          const was = current.get(file.venueId, file.path) as Row | undefined;

          /**
           * **Ready stays ready, and this is the line that guarantees it.**
           *
           * An index venue re-offers the same bare names on every walk. Routing on
           * the sighting alone would drag every settled file back into `wip` and
           * send the probe round again from nothing, once per refresh, for ever. So
           * a sighting that states nothing about a file already catalogued moves
           * `last_seen` and stops there — the same rule `restated` applies
           * everywhere else, decided one step earlier.
           */
          if (! ready(file)) {
            if (was) seen.run(file.seenAt, file.venueId, file.path);
            else moved(file.venueId, backlog.park({
              venueId:   file.venueId,
              path:      file.path,
              date:      file.date,
              size:      file.size,
              etag:      file.etag,
              modified:  file.modified,
              seriesId:  file.seriesId,
              existence: file.existence,
              seenAt:    file.seenAt,
            }));

            continue;
          }

          // Complete this time. If it had been parked, it is parked no longer.
          if (! was) moved(file.venueId, backlog.unpark(file.venueId, file.path));

          const changed = !! was && restated(file, was);

          // Appended to only when a *stated* field differs from a known one.
          // Silence is not a change.
          if (changed)
            revise.run(
              file.venueId, file.path, file.seenAt,
              was.size, was.etag, was.modified, was.downloadedAt,
            );

          // Unchanged keeps whatever it had; changed and new both start pending.
          const downloadedAt = changed ? null : was?.downloadedAt ?? null;

          insert.run(
            file.venueId, file.path, file.date,
            file.size, file.etag, file.modified, file.existence, file.seriesId,
            file.seenAt, file.seenAt, downloadedAt,
          );

          effects.push({
            venueId: file.venueId,
            was:     was ? stateOf(was.seriesId, was.date, was.existence, was.size, was.downloadedAt) : null,
            now:     stateOf(file.seriesId, file.date, file.existence, file.size ?? was?.size ?? null, downloadedAt),
          });

          sighted.push({ seriesId: file.seriesId, date: file.date });
        }

        // In the same transaction as the rows, so the counters cannot survive a
        // rollback of what they describe.
        cache.record(db, (effects));

        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');

        throw err;
      }

      for (const [venueId, delta] of parked) wip.counted(db, venueId, delta);

      return { sighted };
    });

    /**
     * **Outside the slice as well as outside the transaction.** Bounds are held
     * in memory and flushed on their own schedule, which is not work the budget
     * above was measured for.
     */
    for (const one of sighted) sawFile(db, one.seriesId, one.date);
  }

  return files.length;
};





/**
 * Park keys nobody generated, because an answer implied them.
 *
 * **The other way into `wip`.** Everything else there was walked or generated
 * from a pattern; these were named by the venue's own answer — the next part of
 * a split file, the members a manifest lists — and carry the series and period
 * of the row that revealed them, because that is what they are part of.
 *
 * A key already parked is left exactly as it is: it may have attempts against it
 * already, and this is not new information about it.
 */
export const parkKeys = (db: DatabaseSync, rows: readonly Parking[]): number =>
  wip.park(db, rows);

/**
 * Mark everything in a range the walk did not offer this time as gone.
 *
 * Nothing is deleted. A file a venue has withdrawn keeps its row, its history
 * and its `seen_at`, and only its `existence` changes — so the catalog stays a
 * record of everything ever published, and a consumer that wants only live files
 * says so.
 *
 * `last_seen` older than the run that just covered this range means the walk
 * passed the key's position and the venue did not offer it. `COALESCE` covers
 * rows written before `last_seen` existed.
 */
export const markWithdrawn = (
  db:      DatabaseSync,
  venueId: number,
  from:    string,
  to:      string,
  since:   string,
): number => {
  const WHERE = `venue_id = ? AND path >= ? AND path < ?
                   AND existence != 'absent'
                   AND COALESCE(last_seen, seen_at) < ?`;

  db.exec('BEGIN');

  try {
    /**
     * **Read before writing, so the counters know what moved.** The update is a
     * range, not a row, and an aggregate cannot be derived from `changes`. This
     * costs one read of exactly the rows about to change — proportional to the
     * withdrawal rather than to the venue — and a withdrawal is rare.
     */
    const going = db.prepare(
      `SELECT series_id AS seriesId, date, size, existence, downloaded_at AS downloadedAt
         FROM file WHERE ${WHERE}`,
    ).all(venueId, from, to, since) as unknown as Row[];

    const result = db.prepare(`UPDATE file SET existence = 'absent' WHERE ${WHERE}`)
      .run(venueId, from, to, since);

    /**
     * **A withdrawal reaches the backlog too.** A file the venue dropped before
     * anyone probed it was never catalogued, so there is nothing to keep a
     * record of and nothing counted to correct — but leaving it would park it in
     * the probe's queue for ever, asking a venue about a key it no longer serves.
     */
    const unparked = wip.dropRange(db, venueId, from, to, since);

    cache.record(db, (going.map(row => ({
      venueId,
      was: stateOf(row.seriesId, row.date, row.existence, row.size, row.downloadedAt),
      now: stateOf(row.seriesId, row.date, 'absent',      row.size, row.downloadedAt),
    }))));

    db.exec('COMMIT');

    wip.counted(db, venueId, -unparked);

    return Number(result.changes);
  } catch (err) {
    db.exec('ROLLBACK');

    throw err;
  }
};

/**
 * Record that files are now on disk.
 *
 * **Idempotent, and deliberately not transactional with the download itself.** A
 * file fetched but never reported simply comes round in the next batch, where
 * the downloader finds it already there and reports it then — so the record
 * heals itself, and the same path is what lets a venue whose files are already
 * on disk be adopted without any seeding step.
 *
 * Only rows still pending are touched, so a repeat costs nothing and cannot
 * double-count the rollup.
 */
export const markDownloaded = (
  db:    DatabaseSync,
  files: readonly { venueId: number; path: string }[],
  at:    string,
): number => {
  if (files.length === 0) return 0;

  const pending = db.prepare(
    `SELECT series_id AS seriesId, date, size, existence, downloaded_at AS downloadedAt
       FROM file WHERE venue_id = ? AND path = ? AND downloaded_at IS NULL`,
  );

  const mark = db.prepare(
    `UPDATE file SET downloaded_at = ?
      WHERE venue_id = ? AND path = ? AND downloaded_at IS NULL`,
  );

  db.exec('BEGIN');

  try {
    const effects: FileEffect[] = [];

    for (const { venueId, path } of files) {
      const row = pending.get(venueId, path) as Row | undefined;

      // Already marked, or never catalogued. Either way there is nothing to
      // move and nothing to count.
      if (! row) continue;

      mark.run(at, venueId, path);

      effects.push({
        venueId,
        was: stateOf(row.seriesId, row.date, row.existence, row.size, null),
        now: stateOf(row.seriesId, row.date, row.existence, row.size, at),
      });
    }

    cache.record(db, (effects));

    db.exec('COMMIT');

    return effects.length;
  } catch (err) {
    db.exec('ROLLBACK');

    throw err;
  }
};

/**
 * Rule one key absent, because the venue no longer serves it.
 *
 * **The per-key half of a withdrawal.** A re-walk withdraws a whole prefix at
 * once — every row a pass did not see again — but a downloader reporting that
 * one key never delivered is a different occasion: one file, checked against the
 * venue there and then. The row is marked rather than deleted, because what a
 * venue once published stays on record.
 *
 * This is what lets a partition finish. A key that is offered, never downloads
 * and is never withdrawn holds its month open for ever — correctly, since one of
 * the two services is wrong — so withdrawing is how the disagreement ends when
 * the venue agrees the file has gone.
 */
export const withdrawFile = (db: DatabaseSync, venueId: number, path: string): boolean => {
  const current = db.prepare(
    `SELECT series_id AS seriesId, date, size, existence, downloaded_at AS downloadedAt
       FROM file WHERE venue_id = ? AND path = ?`,
  );

  db.exec('BEGIN');

  try {
    const was = current.get(venueId, path) as Row | undefined;

    if (! was || was.existence === 'absent') {
      db.exec('COMMIT');

      return false;
    }

    db.prepare(`UPDATE file SET existence = 'absent' WHERE venue_id = ? AND path = ?`)
      .run(venueId, path);

    cache.record(db, ([{
      venueId,
      was: stateOf(was.seriesId, was.date, was.existence, was.size, was.downloadedAt),
      now: stateOf(was.seriesId, was.date, 'absent',      was.size, was.downloadedAt),
    }]));

    db.exec('COMMIT');

    return true;
  } catch (err) {
    db.exec('ROLLBACK');

    throw err;
  }
};

/**
 * Replace what is recorded about a file with what was actually observed.
 *
 * **For when the archive changed under us.** A downloader that fetches a file
 * and finds different bytes has not hit an error — it has found a new version,
 * and it is holding it. Discarding that would be absurd and reporting a plain
 * success would leave the catalog stating something untrue, so the observation
 * is recorded and the displaced version goes to the trail with the download
 * state it had.
 *
 * `downloaded` says whether the caller holds these bytes. A downloader that just
 * fetched them does; a script correcting a record from the outside does not, and
 * the file stays owed until something goes and gets it.
 *
 * **What is passed here has already been confirmed against the venue.** This
 * writes; deciding whether to believe a report is the caller's, because only the
 * caller can ask the adapter — see `confirm` on a scanner.
 */
export const correctFile = (
  db:         DatabaseSync,
  venueId:    number,
  path:       string,
  observed:   Metadata,
  seenAt:     string,
  downloaded: boolean,
): boolean => {
  const current = db.prepare(
    `SELECT series_id AS seriesId, date, size, etag, modified, existence, downloaded_at AS downloadedAt
       FROM file WHERE venue_id = ? AND path = ?`,
  );

  db.exec('BEGIN');

  try {
    const was = current.get(venueId, path) as Row | undefined;

    if (! was) {
      db.exec('COMMIT');

      return false;
    }

    if (restated(observed, was))
      db.prepare(
        `INSERT INTO revision (venue_id, path, seen_at, size, etag, modified, downloaded_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (venue_id, path, seen_at) DO NOTHING`,
      ).run(venueId, path, seenAt, was.size, was.etag, was.modified, was.downloadedAt);

    const downloadedAt = downloaded ? seenAt : null;
    const size         = observed.size ?? was.size;

    db.prepare(
      `UPDATE file
          SET size = COALESCE(?, size), etag = COALESCE(?, etag),
              modified = COALESCE(?, modified), last_seen = ?, downloaded_at = ?
        WHERE venue_id = ? AND path = ?`,
    ).run(observed.size, observed.etag, observed.modified, seenAt, downloadedAt, venueId, path);

    cache.record(db, ([{
      venueId,
      was: stateOf(was.seriesId, was.date, was.existence, was.size, was.downloadedAt),
      now: stateOf(was.seriesId, was.date, was.existence, size, downloadedAt),
    }]));

    db.exec('COMMIT');

    return true;
  } catch (err) {
    db.exec('ROLLBACK');

    throw err;
  }
};

/**
 * Every venue there is anything to say about, with its totals.
 *
 * Summed from the rollup rather than cached again: a venue is a few hundred
 * month rows, so this is instant, and a second cache would be a second thing
 * that can disagree with the first. `firstMonth` and `lastMonth` fall out of the
 * same rows, which is why they need no column of their own.
 *
 * A venue served by two hosts is one row here — the caller asked about a venue.
 */
export const venueTotals = (db: DatabaseSync): VenueTotals[] =>
  db.prepare(
    `SELECT v.name                                    AS venue,
            COALESCE(MIN(CASE WHEN m.files > 0 THEN m.month END), NULL) AS firstMonth,
            COALESCE(MAX(CASE WHEN m.files > 0 THEN m.month END), NULL) AS lastMonth,
            COALESCE(SUM(m.files), 0)                 AS files,
            COALESCE(SUM(m.bytes), 0)                 AS bytes,
            COALESCE(SUM(m.pending), 0)               AS pending,
            COALESCE(SUM(m.pending_bytes), 0)         AS pendingBytes,
            COALESCE(SUM(m.withdrawn), 0)             AS withdrawn
       FROM venue v LEFT JOIN rollup_venue m ON m.venue_id = v.id
      GROUP BY v.name
      ORDER BY v.name`,
  ).all() as unknown as VenueTotals[];


/**
 * Files whose metadata nobody has established yet, **oldest first**.
 *
 * Date order rather than path order because everything downstream is organised
 * by month: downloads, partitions, cold storage. Completing the catalog
 * month-major means whoever is waiting on a period gets unblocked in the order
 * they will ask, rather than in whatever order the paths happen to sort.
 *
 * `(date, path)` is the keyset, passed back as `after` to continue. That is a
 * cursor by **value**, not an open statement: SQLite will happily let a query
 * step while the same connection rewrites the rows it is walking, and what
 * happens then depends on which index the planner chose — rows visited twice,
 * or not at all, with nothing said. A keyset cannot be wrong that way, and it
 * survives a restart because it is two short strings.
 *
 * Rows already ruled absent are left out: somebody decided that, and asking the
 * venue about them again is exactly what they decided against.
 */
export const unsettled = (
  db:      DatabaseSync,
  venueId: number,
  after:   number,
  limit:   number,
): Unsettled[] => wip.next(db, venueId, after, limit);

/**
 * Record that these rows were asked about and did not settle.
 *
 * One transaction, because a pass that counted its attempts and then died
 * half-way would give some rows a free retry and not others — and the count is
 * the only thing standing between a constructed key that cannot exist and being
 * asked about it for ever.
 */
export const missedFiles = (db: DatabaseSync, rows: readonly Unsettled[]): number =>
  wip.missed(db, rows);

/**
 * Forget candidates nobody is going to settle.
 *
 * **Deleted rather than marked absent.** `existence` carries claims about what a
 * venue published, and these rows were never claims — they are keys this service
 * constructed and asked about. Recording "okx withdrew this" for a file okx
 * never had would put a fiction where a measurement belongs, and `span` already
 * holds the honest version: the bounds these were generated inside.
 */
export const dropWip = (db: DatabaseSync, rows: readonly Unsettled[]): number =>
  wip.drop(db, rows);

/**
 * How much of this venue's backlog is still outstanding.
 *
 * **Every row in `wip` is outstanding**, which is what the table is: a candidate
 * leaves it by being settled, given up on or withdrawn, and all three delete it.
 * Nothing there is ever `absent` — a ruling of absence belongs to `file` — so
 * testing for it read every row of the slice to filter none of them, on a table
 * that reaches tens of millions per venue.
 */
export const countUnsettled = (db: DatabaseSync, venueId: number): number =>
  wip.parked(db, venueId);

/** Whether anything is outstanding, which is the question a drain actually asks. */
export const anyUnsettled = (db: DatabaseSync, venueId: number): boolean =>
  wip.anyParked(db, venueId);

/**
 * Promote what a probe established, as one transaction.
 *
 * **A probe finishes a discovery rather than editing a record.** Its subjects
 * live in `wip` — names a walk could say nothing about — and settling one is
 * what earns it a place in the catalog proper. So this moves a row rather than
 * updating one, and a file arrives in `file` complete or not at all.
 *
 * **Arriving is first discovery, not a revision.** Learning a file's size for
 * the first time is not the file changing, so nothing is appended to the trail
 * here. Without that distinction every file a probe ever touched would land in
 * `revision` on arrival, turning "what changed since I last looked" into
 * "everything, once".
 *
 * A settlement that still states too little leaves the row where it is, with
 * whatever it did learn: a HEAD that answered without a checksum is progress,
 * not an arrival.
 *
 * `existence` is written only when the caller supplied one. Metadata and
 * absence are separate claims, and a probe makes the second only on instruction.
 */
export const settleFiles = (db: DatabaseSync, settled: readonly Settlement[]): number => {
  if (settled.length === 0) return 0;

  const backlog = wip.writer(db);

  const arrive = db.prepare(
    `INSERT INTO file (venue_id, path, date, size, etag, modified, existence,
                       series_id, seen_at, last_seen, downloaded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (venue_id, path) DO NOTHING`,
  );


  /** As in `putFiles`: applied after the commit, never on a row that stayed. */
  const answered: { seriesId: number; date: string }[] = [];

  /** What left the backlog, reported to `wip` once this has committed. */
  const unparked = new Map<number, number>();

  db.exec('BEGIN');

  try {
    const effects: FileEffect[] = [];
    let   moved  = 0;

    for (const file of settled) {
      const was = backlog.held(file.venueId, file.path);

      // Not parked: either already catalogued, or never discovered. Neither is
      // this function's business -- a correction goes through `correctFile`.
      if (! was) continue;

      const merged = {
        size:     file.size     ?? was.size,
        etag:     file.etag     ?? was.etag,
        modified: file.modified ?? was.modified,
      };

      backlog.learn(file.size, file.etag, file.modified,
        file.existence ?? null, file.venueId, file.path);

      if (! ready(merged)) continue;

      const existence = file.existence ?? 'confirmed';

      const arrived = Number(arrive.run(
        file.venueId, file.path, was.date,
        merged.size, merged.etag, merged.modified, existence, was.seriesId,
        was.seenAt, file.seenAt,
      ).changes) > 0;

      unparked.set(file.venueId,
        (unparked.get(file.venueId) ?? 0) + backlog.unpark(file.venueId, file.path));
      moved++;

      answered.push({ seriesId: was.seriesId, date: was.date });

      /**
       * **Counted only where a row actually arrived.**
       *
       * Nothing was counted while it was parked, so a file reaching the catalog
       * here is purely an addition with no prior state to subtract — but the
       * insert leaves an existing row alone, and a key can be parked for a path
       * the catalog already holds: generation reads the tip and nothing else, and
       * a walk can catalogue a path while a row for it sits in the backlog.
       *
       * Counting those was the rollup drifting above the table it describes, by
       * one file per key that settled onto a row already there — 1,937,264 of
       * them, 0.59%, before this was measured.
       */
      if (arrived)
        effects.push({
          venueId: file.venueId,
          was:     null,
          now:     stateOf(was.seriesId, was.date, existence, merged.size, null),
        });
    }

    cache.record(db, (effects));

    db.exec('COMMIT');

    for (const [venueId, delta] of unparked) wip.counted(db, venueId, delta);

    /**
     * **A file that arrived is a sighting however it was found.** A probe found
     * this one by asking about a key nothing listed, which is weaker evidence
     * about the venue and exactly as good about the file — so both bounds move
     * on it, as they would for a walk.
     *
     * Without this they moved only on venues that can be walked, and every
     * generated-key venue looked as though its archive stopped the day it was
     * seeded.
     */
    for (const one of answered) {
      sawFile(db, one.seriesId, one.date);
    }

    return moved;
  } catch (err) {
    db.exec('ROLLBACK');

    throw err;
  }
};

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
 * thirty-nine thousand on htx. Keeping those to record that a pass happened
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
  // without colliding with it. Reachable only if descent hands back the venue
  // root itself as a single partition, which also has no usable range to sweep.
  if (scopes.some(scope => scope === ''))
    throw new Error('A partition cannot be the empty scope: that is the job itself');

  const started = new Date().toISOString();
  const insert  = db.prepare(
    `INSERT INTO run (venue_id, kind, scope, cursor, started) VALUES (?, ?, ?, NULL, ?)`,
  );

  db.exec('BEGIN');

  try {
    insert.run(venueId, kind, '', started);

    for (const scope of scopes) insert.run(venueId, kind, scope, started);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');

    throw err;
  }

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
 * The id of one venue's row, which every other table keys on.
 *
 * **A lookup, never a write.** The rows are constants that arrive with a
 * migration, so a name with no row is a venue this build does not have — a fault
 * worth naming rather than a row to invent.
 */
export const venueIdOf = (db: DatabaseSync, name: string, host = ''): number => {
  const found = db.prepare('SELECT id FROM venue WHERE name = ? AND host = ?')
    .get(name, host) as { id: number } | undefined;

  if (! found)
    throw new Error(`No venue row for '${name}'${host ? ` (${host})` : ''}`
      + ' — venues come from a migration, so this build does not have it');

  return found.id;
};

/**
 * Whether a venue has ever opened a run of this kind.
 *
 * **Asks whether one exists, never how many there are.** A count reads every
 * matching row — htx and bitget carry tens of thousands each — to answer a
 * question the first row already settles.
 */
const ranAny = (db: DatabaseSync, venueId: number, kind: RunKind): boolean =>
  db.prepare('SELECT 1 FROM run WHERE venue_id = ? AND kind = ? LIMIT 1')
    .get(venueId, kind) !== undefined;

/**
 * Every venue the catalog holds, with where it is.
 *
 * Constants of the application rather than anything a survey wrote — they arrive
 * with the `venues` migration and are read back here so the adapters can be
 * given their addresses.
 */
export const venues = (db: DatabaseSync): {
  name: string; host: string; base: string; keyRoot: string;
}[] =>
  db.prepare('SELECT name, host, base, key_root AS keyRoot FROM venue ORDER BY id').all() as unknown as {
    name: string; host: string; base: string; keyRoot: string;
  }[];

/**
 * Whether anybody has ever asked for this venue, and whether it is stopped.
 *
 * **The one thing the run rows cannot say.** They record what has been done;
 * this records whether anything should be — a decision somebody made, which is
 * why it is stored rather than inferred. Absence is the resting state: a
 * deployment nobody has asked anything of surveys nothing, for ever.
 */
export interface Enrolled {
  enrolledAt: string;

  /** When it was stopped, or null while it is running. */
  pausedAt:   string | null;
}

export const enrolled = (db: DatabaseSync, venue: string): Enrolled | null => {
  const row = db.prepare(
    'SELECT enrolled_at AS enrolledAt, paused_at AS pausedAt FROM survey WHERE venue = ?',
  ).get(venue) as Enrolled | undefined;

  return row ?? null;
};

/**
 * Take this venue on, if it is not already.
 *
 * **Enrolling is not resuming.** A venue already enrolled keeps the moment it
 * was first asked for — that is what `enrolled_at` is — and a pause is lifted by
 * `resumeSurvey`, deliberately, so that starting a paused venue is a decision
 * somebody took rather than a side effect of asking twice.
 */
export const enrol = (db: DatabaseSync, venue: string, at: string): void => {
  db.prepare('INSERT OR IGNORE INTO survey (venue, enrolled_at) VALUES (?, ?)').run(venue, at);
};

/** Stop it, and remember when. Answers whether this changed anything. */
export const pauseSurvey = (db: DatabaseSync, venue: string, at: string): boolean =>
  db.prepare('UPDATE survey SET paused_at = ? WHERE venue = ? AND paused_at IS NULL')
    .run(at, venue).changes > 0;

/** Lift a pause. Answers whether there was one. */
export const resumeSurvey = (db: DatabaseSync, venue: string): boolean =>
  db.prepare('UPDATE survey SET paused_at = NULL WHERE venue = ? AND paused_at IS NOT NULL')
    .run(venue).changes > 0;

/** Forget a venue entirely — the resting state, as though it had never been asked for. */
export const unenrol = (db: DatabaseSync, venue: string): void => {
  db.prepare('DELETE FROM survey WHERE venue = ?').run(venue);
};

/**
 * Whether this venue is one this deployment keeps current, and where it got to.
 *
 * **Enrolment is a fact in the database, not a setting.** A venue is surveyed
 * because somebody asked it to be, once — and from then on the run rows say so,
 * whatever restarts happen in between. Nothing here is enrolled by being
 * configured: a deployment that never starts a survey stays read-only for ever,
 * and one that starts a single survey keeps that venue current without being
 * asked again.
 *
 * Two answers, because they lead to different things. An **open** job is work
 * interrupted, and is resumed at once. A **last start** with nothing open is a
 * venue between passes, and its next one is due an interval after that start —
 * possibly in the past, in which case it is due now.
 *
 * `probe` is not consulted: it is the settling half of whichever pass it belongs
 * to rather than a pass of its own.
 */
export interface Enrolment {
  /** The kind of job still open, or null where none is. */
  open:    RunKind | null;

  /** When the most recent job of either kind began, or null where none has. */
  started: string | null;
}

export const enrolment = (db: DatabaseSync, venueId: number): Enrolment => {
  const row = newestRun(db, venueId);

  if (! row) return { open: null, started: null };

  return { open: row.completed === null ? row.kind : null, started: row.started };
};

export const lastRun = (db: DatabaseSync, venueIds: readonly number[]): LastRun => {
  const rows = venueIds
    .map(id => newestRun(db, id))
    .filter((one): one is NonNullable<typeof one> => one !== undefined)
    .sort((a, b) => b.started.localeCompare(a.started));

  /**
   * **Backfilling until every host has read itself through once**, which is the
   * same test `completedEver` answers with — one fact, asked from two places,
   * rather than two rules that can disagree about the same venue.
   */
  const first = ! venueIds.every(id => everCompleted(db, id));

  const open = rows.find(one => one.completed === null);

  if (open)
    return { kind: open.kind, at: null, startedAt: open.started, ongoing: true, first };

  const done = rows[0];

  return done
    ? { kind: done.kind, at: done.completed, startedAt: done.started, ongoing: false, first }
    : { kind: null, at: null, startedAt: null, ongoing: false, first: false };
};

/**
 * When this venue's newest walk began, or undefined where it has never walked.
 *
 * **Its start, because that is what a cadence counts from**: a walk that ran for
 * thirty hours was still this venue's reading of the archive as it stood when it
 * opened.
 *
 * **Whether it completed is not asked, because it cannot differ.** The only
 * caller is the recurrence decision, and that is reached solely from the
 * `updating` phase — a venue whose walk has not finished keeps walking by the
 * phase rule in `passFor` and never gets there. So the newest walk row here is
 * always a finished one.
 */
export const walkedAt = (db: DatabaseSync, venueId: number): string | undefined =>
  (db.prepare(
    `SELECT MAX(started) AS started FROM run
      WHERE venue_id = ? AND scope = '' AND kind = 'walk'`,
  ).get(venueId) as { started: string | null }).started ?? undefined;

/** One host's newest whole pass of either kind, however it ended. */
const newestRun = (db: DatabaseSync, venueId: number) =>
  db.prepare(
    `SELECT kind, started, completed FROM run
      WHERE venue_id = ? AND scope = '' AND kind IN ('walk', 'update')
      ORDER BY started DESC
      LIMIT 1`,
  ).get(venueId) as { kind: RunKind; started: string; completed: string | null } | undefined;

/**
 * Where a venue stands, from the two things that decide it.
 *
 * **`survey` says whether it should be running; `run` says what it is doing.**
 * Neither answers on its own, and keeping them apart is what stops the pair
 * disagreeing: a venue can be enrolled with no job (waiting for the next
 * update), or have an open job while nobody is working it (a killed container,
 * or a pause).
 *
 * The interval is measured from the **start** of the last pass rather than its
 * end, so a walk that ran longer than the interval is already overdue when it
 * finishes — and a restart cannot change a venue's cadence.
 */
export const standingOf = (
  db:       DatabaseSync,
  venue:    string,
  venueIds: readonly number[],
  everyMs:  number,
): Omit<Standing, 'surveying' | 'stopping'> => {
  const held = enrolled(db, venue);

  if (! held)
    return { state: 'not started', enrolledAt: null, since: null, during: null, nextRun: null };

  /** Any host mid-job makes the venue mid-job; the newest start sets the clock. */
  const open    = venueIds.map(id => enrolment(db, id)).filter(one => one.open !== null);
  const started = venueIds
    .map(id => enrolment(db, id).started)
    .filter((one): one is string => one !== null)
    .sort()
    .at(-1) ?? null;

  const doing = open.length === 0 ? 'waiting'
    : open.some(one => one.open === 'walk') ? 'walking' : 'updating';

  const nextRun = doing === 'waiting' && started !== null
    ? new Date(Date.parse(started) + everyMs).toISOString()
    : null;

  return held.pausedAt === null
    ? {
      state:      doing,
      enrolledAt: held.enrolledAt,
      since:      open.length === 0 ? null : started,
      during:     null,
      nextRun,
    }
    : {
      /** Paused says who stopped it; `during` says what it would go back to. */
      state:      'paused',
      enrolledAt: held.enrolledAt,
      since:      held.pausedAt,
      during:     doing,
      nextRun,
    };
};

/**
 * How far a venue has got, in one word, read entirely off its rows.
 *
 * **Nothing records this separately.** Two places to keep a state is two places
 * to disagree, and every question the phase answers is already answered by which
 * runs exist and which have finished:
 *
 * - no runs at all, so nothing has ever started
 * - runs exist, none has turned a page: the brief moment after they are created
 * - something still has keyspace ahead of its cursor
 * - everything is exhausted, and a job has closed over it before, so what is
 *   left is finding what has appeared since
 *
 * **Having been complete once is permanent**, and a closed job is what records
 * it: a venue never goes back to walking scopes it has already exhausted.
 *
 * **Read off whichever kind of run the venue actually does.** A venue with a
 * keyspace to read walks it; okx and bitget have none and only ever generate
 * keys from their series, so they have `update` rows and never a single
 * `walk` — and asking only about walks reports them as `not run` however many
 * millions of files they have established. Nothing here names a venue: the rows
 * say which kind it is.
 */
export const phaseOf = (db: DatabaseSync, venueId: number): Phase => {
  const kind: RunKind = ranAny(db, venueId, 'walk') ? 'walk' : 'update';

  const working = openPartitions(db, venueId, kind).filter(run => run.scope !== '');

  if (working.length > 0)
    return working.some(run => run.requests > 0) ? 'running' : 'planned';

  if (! ranAny(db, venueId, kind)) return 'not run';

  return everCompleted(db, venueId) ? 'updating' : 'complete';
};

/**
 * Whether this venue has ever finished a pass of the kind it is surveyed by.
 *
 * **The condition `force-update` turns on**, and the reason it is a query of its
 * own rather than a reading of `phaseOf`. A venue paused halfway through an
 * update has open partitions, so its phase is `running` — which says where it is
 * now and cannot say whether it has ever been complete. Those are the two
 * halves of the question: forcing an update is refused where no pass has ever
 * finished, and *resuming* one is exactly the case where a pass is open.
 *
 * Read off whichever kind the venue actually runs, so a venue with no keyspace
 * to walk — okx, bitget — answers about its updates instead of about walks it
 * will never have.
 */
export const everCompleted = (db: DatabaseSync, venueId: number): boolean => {
  const kind: RunKind = ranAny(db, venueId, 'walk') ? 'walk' : 'update';

  return db.prepare(
    `SELECT 1 FROM run
      WHERE venue_id = ? AND kind = ? AND scope = '' AND completed IS NOT NULL LIMIT 1`,
  ).get(venueId, kind) !== undefined;
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

/**
 * When a prefix was last established, or null if it never was.
 *
 * **Returns the walk's `started`, not its `completed`.** That is the honest
 * claim: a walk guarantees the archive as it was when it began, and anything it
 * picked up later is incidental. Reporting the finish time would claim hours or
 * days the walk never looked at.
 *
 * Completion propagates **downward**: a walk of `spot/` settles everything
 * beneath it, so a question about `spot/monthly/klines/` is answered by any
 * ancestor that has been walked. Asking is therefore one indexed lookup over a
 * handful of keys rather than a scan.
 *
 * Where several ancestors qualify, the answer is the **latest** of them. Each is
 * a true statement about this prefix — an ancestor's walk covered it — so the
 * strongest true statement is the most recent one. Taking the shortest ancestor
 * instead would let a venue-wide pass from last month shadow a walk of this very
 * prefix from an hour ago, and understate what is known.
 */
export const establishedAt = (
  db:      DatabaseSync,
  venueId: number,
  prefix:  string,
): string | null => {
  const chain = ancestorsOf(prefix);
  const holes = chain.map(() => '?').join(', ');

  /**
   * **A completed ancestor does not count while anything below it is still
   * being walked.**
   *
   * Splitting a partition closes the parent and creates children carrying the
   * rest of its keyspace — so the parent's `completed` says "this run stopped",
   * not "this prefix is established". Read without the guard, a venue would
   * claim a whole tree the moment it was divided, which is the same false
   * completeness claim that once closed binance over keyspace nobody had read.
   *
   * The descendant test is a prefix comparison rather than `LIKE`, so a scope
   * containing `%` or `_` cannot quietly match more than itself.
   */
  const row = db.prepare(
    `SELECT MAX(r.started) AS started FROM run r
      WHERE r.venue_id = ? AND r.scope IN (${holes}) AND r.completed IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM run o
           WHERE o.venue_id = r.venue_id AND o.kind = r.kind
             AND o.completed IS NULL AND o.scope != ''
             AND substr(o.scope, 1, length(r.scope)) = r.scope
        )`,
  ).get(venueId, ...chain) as { started: string | null };

  return row.started;
};

/**
 * Record paths a venue served that no adapter could read into a series.
 *
 * **An upsert keyed by path**, so a shape met again on the next pass raises a
 * count rather than filling the table: what matters when this is read is how
 * many distinct shapes are unaccounted for, and how much of the archive each one
 * covers.
 */
export const putUnreadable = (
  db:      DatabaseSync,
  venueId: number,
  paths:   readonly { path: string; reason: string }[],
): void => {
  if (paths.length === 0) return;

  const at   = new Date().toISOString();
  const save = db.prepare(
    `INSERT INTO unreadable (venue_id, path, reason, seen, first_seen, last_seen)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT (venue_id, path) DO UPDATE
        SET seen = seen + 1, last_seen = excluded.last_seen, reason = excluded.reason`,
  );

  for (const one of paths) save.run(venueId, one.path, one.reason, at, at);
};

/** The worklist for one venue, or for every venue when none is named. */
export const unreadable = (db: DatabaseSync, venueId?: number): Unreadable[] =>
  db.prepare(
    `SELECT v.name AS venue, v.host, u.path, u.reason, u.seen,
            u.first_seen AS firstSeen, u.last_seen AS lastSeen
       FROM unreadable u JOIN venue v ON v.id = u.venue_id
      ${venueId === undefined ? '' : 'WHERE u.venue_id = ?'}
      ORDER BY u.seen DESC, u.path`,
  ).all(...(venueId === undefined ? [] : [venueId])) as unknown as Unreadable[];

/**
 * Every file this venue serves that is not historical data.
 *
 * The paths alone, which is all a walk needs to refuse one.
 */
export const exclusionsFor = (db: DatabaseSync, venueId: number): string[] =>
  (db.prepare('SELECT path FROM exclusion WHERE venue_id = ?')
    .all(venueId) as unknown as { path: string }[]).map(row => row.path);

/**
 * Every prefix that contains this one, longest last, including it and the empty
 * prefix that means the whole venue.
 *
 * `spot/monthly/klines/` → `['', 'spot/', 'spot/monthly/', 'spot/monthly/klines/']`
 */
export const ancestorsOf = (prefix: string): string[] => {
  const parts = prefix.split('/').filter(Boolean);
  const chain = [''];

  let walked = '';

  for (const part of parts) {
    walked += `${part}/`;
    chain.push(walked);
  }

  return chain;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** The three fields a sighting may or may not state about a file. */
interface Metadata {
  size:     number | null;
  etag:     string | null;
  modified: string | null;
}

/** A stored row, as the statements above read it back. */
interface Row extends Metadata {
  seriesId:     number;
  date:         string;
  existence:    Existence;
  downloadedAt: string | null;
}

/**
 * Whether a finding is complete enough to be catalogued.
 *
 * **Size and checksum, because those are what the catalog promises.** `bytes` is
 * a real total only if every row has a size, and a downloader can check what it
 * received only against a checksum — a row missing either would make one of
 * those a lie for as long as it sat there.
 *
 * A venue that published sizes and no checksums would sit in `wip` for ever
 * waiting for something that is never coming. None does today: the listing
 * venues state all three with every key, and the one index venue states none.
 * If one appears, this is the line to revisit rather than the place to special
 * case it.
 */
const ready = (seen: Metadata): boolean => seen.size !== null && seen.etag !== null;

/**
 * What a row counts as in the rollup.
 *
 * The month is the date's first six characters — the one interpretation the
 * catalog makes of a stored value, and one it already makes elsewhere.
 */
const stateOf = (
  seriesId:     number,
  date:         string,
  existence:    Existence,
  size:         number | null,
  downloadedAt: string | null,
): FileState => ({
  seriesId,
  month:      date.slice(0, 6),
  confirmed:  existence === 'confirmed',
  downloaded: downloadedAt !== null,
  bytes:      size ?? 0,
});

/**
 * Whether a sighting **states** something that differs from what is known.
 *
 * The distinction the whole trail rests on: a field left unsaid is not a field
 * that changed. A walk of an HTML index says nothing about size or checksum, and
 * treating that silence as "now null" would put every file in `revision` on
 * every refresh — turning "what changed since I last looked" into "everything".
 */
const restated = (seen: Metadata, was: Metadata): boolean =>
  (seen.size !== null && seen.size !== was.size)
  || (seen.etag !== null && ! sameTag(seen.etag, was.etag))
  || (seen.modified !== null && seen.modified !== was.modified);

/**
 * **The case of an ETag belongs to the server, not to the file.** Sightings are
 * normalised on the way in, so this only matters for rows stored before that
 * was true — but getting it wrong here is expensive rather than untidy: a
 * spurious difference appends a revision and clears `downloaded_at`, turning a
 * file already on disk back into one that is owed.
 */
const sameTag = (seen: string | null, was: string | null): boolean =>
  seen?.toLowerCase() === was?.toLowerCase();

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

  db.exec('BEGIN');

  try {
    // Closed rather than deleted: what a partition read is part of the job's
    // history, and its `requests` and `found` still count towards the pass.
    db.prepare('UPDATE run SET completed = ?, cursor = NULL WHERE id = ?')
      .run(new Date().toISOString(), parent.id);

    for (const [scope, cursor] of wanted)
      insert.run(parent.venueId, parent.kind, scope, cursor, parent.started);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');

    throw err;
  }

  return openPartitions(db, parent.venueId, parent.kind)
    .filter(run => wanted.some(([scope]) => scope === run.scope));
};

/**
 * Which children still have keyspace to read, and from where.
 *
 * A prefix covers everything from itself up to its `ceiling` — the prefix with
 * its last character incremented — so a cursor at or past that ceiling means the
 * whole child has been walked. Below the child's own start, nothing of it has.
 */
const progress = (
  cursor:   string | null,
  children: readonly string[],
): [string, string | null][] => {
  if (cursor === null) return children.map(scope => [scope, null]);

  const out: [string, string | null][] = [];

  for (const scope of children) {
    if (cursor >= ceiling(scope)) continue;               // wholly read

    out.push([scope, cursor >= scope ? cursor : null]);   // resumes, or fresh
  }

  return out;
};

// ── Test access ───────────────────────────────────────────────────────────────

/**
 * The slice budget, so the test that asserts the loop turns over between
 * writers measures against the real figure rather than a copy of it that can
 * drift.
 */
export const _test_BREATH_MS = BREATH_MS;
