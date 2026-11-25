import type { DatabaseSync } from 'node:sqlite';
import * as cache from './cache/partitions';
import * as wip from './wip';
import { BREATH_MS, slice } from './serial';
import { byteOrder, ceiling } from '../paths';
import { sawFile } from './series';
import { noteWithdrawals } from './withdrawals';
import { inTransaction } from './tx';
import { statement } from './state';
import { CURRENT, REVISE, ROW, ready, replaced, stateOf, unchanged } from './rows';
import { below, dropParked, inSpan, isRange, rowsIn, vacated, withdraw } from './spans';
import type { FileMetadata as Metadata, FileRow as Row } from '../types';
import type { CatalogFile, FileEffect, RangeSpan, Settlement, Span, Withdrawal } from '../types';

/**
 * The catalogued files: what a walk, a probe or a downloader says about them,
 * written to `file` with the partitions they count in and the trail of the
 * versions they replaced.
 *
 * The queries are shaped around two access patterns and no others: **insert a
 * page of discovered files**, and **ask what is known for a venue, a date range
 * and a path prefix**. Anything that needs a different shape needs a new
 * function here rather than a query written at the call site, so the indexes
 * that make it fast stay next to the statements that need them.
 */

/**
 * Record a page of files, and — where the page says what it covered — what the
 * venue no longer offers inside it.
 *
 * Batched deliberately rather than written row by row: the transaction is what
 * makes a hundred thousand inserts take under a second, and keeping each batch
 * short is what stops a long walk holding the write lock against anyone else.
 *
 * Three things happen to a key seen again:
 *
 * - **Nothing, where it says nothing new.** Same size, ETag, `modified`, date,
 *   series and existence: the row already states it, so it is not written. On a
 *   re-walk that is nearly every key, and rewriting each one to say so would be
 *   most of what a walk costs.
 * - `seen_at` is left alone. It is first discovery, and answers "when did we
 *   first learn this existed" — a question whose answer must not drift. A key
 *   parked before a listing described it was discovered when it was parked.
 * - If size or ETag differ, the new version becomes current, **the one it
 *   replaced is appended to `revision`** — so a consumer can ask what changed
 *   since it last looked rather than being told only that something did — and
 *   it is owed again.
 * - If only the venue's `modified` differs, the new time is recorded and
 *   nothing else moves: the bytes are the ones already known.
 *
 * **A walked page states a span exhaustively** — see `Span` — so a file
 * catalogued inside it that the page did not list has been withdrawn, and is
 * marked so here, in the same slices. Nothing is deleted: a withdrawn file keeps
 * its row, its history and its `seen_at`, and only its `existence` changes.
 * Without a span — keys that did not come from a listing — nothing is withdrawn.
 *
 * **What the page listed is not always what it catalogues.** `listed` is every
 * path the page named, rows or not; a path in it is never withdrawn, so a key
 * the caller chose not to write still counts as offered. Without it, the files
 * written are all the page offered.
 *
 * **A file ready to be catalogued is `confirmed` or `absent`**, the two states
 * `file` holds; `assumed` describes a key nobody has seen, which is parked and
 * never catalogued. A page offering a ready file in any other state is refused
 * whole, before anything is written.
 *
 * Returns how many files were withdrawn.
 */
export const putFiles = async (
  db:      DatabaseSync,
  files:   readonly CatalogFile[],
  span?:   Span,
  listed?: ReadonlySet<string>,
): Promise<number> => {
  if (files.length === 0 && ! span) return 0;

  const misplaced = files.find(file => ready(file) && file.existence !== 'confirmed' && file.existence !== 'absent');

  if (misplaced)
    throw new Error(`${misplaced.path}: a catalogued file is 'confirmed' or 'absent', not '${misplaced.existence}'`);

  const current = db.prepare(CURRENT);

  const revise = db.prepare(REVISE);

  const insert = db.prepare(
    `INSERT INTO file (venue_id, path, date, size, etag, modified, existence,
                       series_id, partition_id, seen_at, downloaded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue_id, path) DO UPDATE SET
          date          = excluded.date,
          series_id     = excluded.series_id,
          partition_id  = excluded.partition_id,
          size          = COALESCE(excluded.size, file.size),
          etag          = COALESCE(excluded.etag, file.etag),
          modified      = COALESCE(excluded.modified, file.modified),
          existence     = excluded.existence,
          downloaded_at = excluded.downloaded_at`,
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

  /** Every path the page offered, so what it did not offer can be told apart. */
  const offered = listed ?? new Set(files.map(file => file.path));

  /**
   * **In the order the span is read**, which is the bytes' order rather than
   * JavaScript's, so a slice can say where in the span it stopped.
   */
  const ordered = span ? [...files].sort((a, b) => byteOrder(a.path, b.path)) : files;

  /**
   * **A key range is read once, before any slice**, not once per slice. One
   * ordered read of the span answers every lookup in the page and says what was
   * catalogued there besides — the whole of what withdrawal needs. Read inside a
   * slice it counted against that slice's own budget, so a slice got through a
   * few keys and the next read the rest of the span again: a page cost the
   * square of its size.
   *
   * **Only what is written is read again.** Between slices another writer may
   * touch a row — a probe settling it, a report marking it downloaded — so a key
   * about to be written, parked or withdrawn is looked up afresh inside the
   * transaction that writes it. A key that said nothing new is skipped on the
   * span's word: if the row moved meanwhile, what moved it stands.
   */
  const spanned = span && isRange(span)
    ? rowsIn(db, span.venueId, { path: span.low, open: span.lowOpen }, { path: span.high, open: span.highOpen })
    : null;

  const known = spanned ? new Map(spanned.map(row => [row.path, row])) : null;

  /** The span's rows not yet judged for withdrawal, by position in `spanned`. */
  let judged = 0;

  /** Where the next slice's stretch of the span begins. */
  let from = span && isRange(span) ? { path: span.low, open: span.lowOpen } : null;

  let withdrawn = 0;

  /** What each slice withdrew or brought back, written to the withdrawals log once it has committed. */
  const notes: Withdrawal[] = [];

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
   * it — and every write here is keyed by path, so writing it twice says exactly
   * what writing it once said.
   */
  for (let at = 0, last = false; ! last;) {
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

      try {
        inTransaction(db, () => {
          const effects: FileEffect[] = [];
          const partitions = cache.resolver(db);

          const fresh = (file: CatalogFile): Row | undefined =>
            current.get(file.venueId, file.path) as Row | undefined;

          /** What the span says of a key, or the row itself where the span cannot answer for it. */
          const said = (file: CatalogFile): Row | undefined =>
            known && inSpan(file.path, span as RangeSpan) ? known.get(file.path) : fresh(file);

          for (; at < ordered.length && Date.now() < until; at++) {
            const file = ordered[at]!;
            const hint = said(file);

            // Nothing new: skipped on the span's word, with no write and no second read.
            if (hint && ready(file) && unchanged(file, hint)) {
              sighted.push({ seriesId: file.seriesId, date: file.date });

              continue;
            }

            const was = known ? fresh(file) : hint;

            /**
             * A file sighted without size or checksum can't be catalogued yet:
             * catalogued means measured. Parked in `wip` for a probe to settle —
             * and if it is already catalogued, the row says more than this
             * sighting does, so nothing is written.
             *
             * **Unless the row says the file was withdrawn.** A listing that names
             * it again is the venue saying otherwise, and a row marked absent
             * says nothing a probe could not correct — so it is asked about, and
             * comes back through `settleFiles` if it is there.
             */
            if (! ready(file)) {
              if (! was || was.existence === 'absent') moved(file.venueId, backlog.park({
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

            sighted.push({ seriesId: file.seriesId, date: file.date });

            if (was && unchanged(file, was)) continue;

            // Complete this time. If it had been parked, it is parked no longer,
            // and it was first sighted when it was parked.
            const parkedAt = was ? null : backlog.take(file.venueId, file.path);

            if (parkedAt !== null) moved(file.venueId, -1);

            const changed = !! was && replaced(file, was);

            // Appended to only when a *stated* size or ETag differs from a known
            // one. Silence is not a change, and neither is a new date on the same bytes.
            if (changed)
              revise.run(
                file.venueId, file.path, file.seenAt,
                was.size, was.etag, was.modified, was.downloadedAt,
              );

            // A changed file is a different file: whatever was downloaded is not it.
            const downloadedAt = changed ? null : was?.downloadedAt ?? null;

            // The partition of where the file is now: its date or its series may have moved.
            const partitionId = partitions.of(file.seriesId, file.date);

            insert.run(
              file.venueId, file.path, file.date,
              file.size, file.etag, file.modified, file.existence, file.seriesId,
              partitionId, parkedAt ?? file.seenAt, downloadedAt,
            );

            effects.push({
              was:  was ? stateOf(was.partitionId, was.existence, was.size, was.etag, was.downloadedAt) : null,
              now:  stateOf(partitionId, file.existence, file.size ?? was?.size ?? null,
                file.etag ?? was?.etag ?? null, downloadedAt),
            });

            if (was?.existence === 'absent' && file.existence !== 'absent')
              notes.push({
                event: 'returned', cause: 'walk', venueId: file.venueId, path: file.path, date: file.date,
                size: file.size ?? was.size, etag: file.etag ?? was.etag,
              });
          }

          last = at >= ordered.length;

          /**
           * **What the span held and the page did not offer.** For a key range,
           * the stretch this slice covered — up to the next unwritten key, or the
           * span's end on the last slice — so every catalogued path in the span
           * is judged exactly once. For a directory, all of it, on the last slice.
           */
          if (span && isRange(span) && spanned) {
            const upto = last ? { path: span.high, open: span.highOpen } : { path: ordered[at]!.path, open: true };

            // The span's rows up to where this slice stopped, each judged once, and re-read before it is marked.
            const gone: { path: string; row: Row }[] = [];

            for (; judged < spanned.length && below(spanned[judged]!.path, upto); judged++) {
              const { path } = spanned[judged]!;

              if (offered.has(path)) continue;

              const row = current.get(span.venueId, path) as Row | undefined;

              if (row && row.existence !== 'absent') gone.push({ path, row });
            }

            withdrawn += withdraw(db, span.venueId, gone, effects, notes);
            moved(span.venueId, dropParked(db, backlog, span.venueId, from!, upto, offered));

            if (! last) from = { path: ordered[at]!.path, open: false };
          }

          if (span && ! isRange(span) && last) {
            const { gone, subtrees } = vacated(db, span, offered);

            withdrawn += withdraw(db, span.venueId, gone, effects, notes);

            for (const tree of subtrees) {
              const rows = rowsIn(db, span.venueId, { path: tree, open: false }, { path: ceiling(tree), open: true });

              withdrawn += withdraw(db, span.venueId,
                rows.filter(row => row.existence !== 'absent').map(row => ({ path: row.path, row })), effects, notes);
              moved(span.venueId, dropParked(db, backlog, span.venueId,
                { path: tree, open: false }, { path: ceiling(tree), open: true }, offered));
            }

            moved(span.venueId, dropParked(db, backlog, span.venueId,
              { path: span.directory, open: false }, { path: ceiling(span.directory), open: true }, offered, true));
          }

          cache.record(db, effects);
        });
      } catch (err) {
        notes.length = 0;

        throw err;
      }

      noteWithdrawals(db, notes.splice(0));

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

  return withdrawn;
};

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
 * **Returning with different bytes is a revision.** A row the catalog holds as
 * withdrawn already has a version; where the probe finds another size or ETag,
 * that version is appended to `revision` — keyed by when the probe observed its
 * replacement — and the file is owed again. The same bytes come back with
 * whatever was downloaded of them.
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
                       series_id, partition_id, seen_at, downloaded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue_id, path) DO UPDATE SET
          date          = excluded.date,
          size          = excluded.size,
          etag          = excluded.etag,
          modified      = excluded.modified,
          existence     = excluded.existence,
          series_id     = excluded.series_id,
          partition_id  = excluded.partition_id,
          downloaded_at = excluded.downloaded_at
        WHERE file.existence = 'absent' AND excluded.existence <> 'absent'`,
  );

  const revise = db.prepare(REVISE);

  /** The row a settlement lands on, where the catalog holds it as withdrawn. */
  const lost = db.prepare(
    `SELECT ${ROW} FROM file WHERE venue_id = ? AND path = ? AND existence = 'absent'`,
  );

  /** Withdrawn files a probe found again, for the withdrawals log. */
  const notes: Withdrawal[] = [];

  /** As in `putFiles`: applied after the commit, never on a row that stayed. */
  const answered: { seriesId: number; date: string }[] = [];

  /** What left the backlog, reported to `wip` once this has committed. */
  const unparked = new Map<number, number>();

  const moved = inTransaction(db, () => {
    const effects: FileEffect[] = [];
    const partitions = cache.resolver(db);
    let   arrivals = 0;

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

      const partitionId = partitions.of(was.seriesId, was.date);

      const gone = lost.get(file.venueId, file.path) as Row | undefined;

      // Different bytes from the withdrawn row's: whatever was downloaded is not them.
      const changed = !! gone && replaced(merged, gone);
      const downloadedAt = gone && ! changed ? gone.downloadedAt : null;

      const arrived = Number(arrive.run(
        file.venueId, file.path, was.date,
        merged.size, merged.etag, merged.modified, existence, was.seriesId,
        partitionId, was.seenAt, downloadedAt,
      ).changes) > 0;

      if (arrived && gone && changed)
        revise.run(file.venueId, file.path, file.seenAt,
          gone.size, gone.etag, gone.modified, gone.downloadedAt);

      unparked.set(file.venueId,
        (unparked.get(file.venueId) ?? 0) + backlog.unpark(file.venueId, file.path));
      arrivals++;

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
       * Counting those would drift the counters above the table they describe, by
       * one file per key that settled onto a row already there.
       *
       * **A row held as withdrawn is the one that does not stay as it was.** The
       * venue serves the file after all, so the row is brought back — and what
       * the archives hold of it still counts where the bytes are the same.
       */
      if (arrived) {
        effects.push({
          was:  gone ? stateOf(gone.partitionId, 'absent', gone.size, gone.etag, gone.downloadedAt) : null,
          now:  stateOf(partitionId, existence, merged.size, merged.etag, downloadedAt),
        });

        if (gone)
          notes.push({
            event: 'returned', cause: 'probe', venueId: file.venueId, path: file.path, date: was.date,
            size: merged.size, etag: merged.etag,
          });
      }
    }

    cache.record(db, (effects));

    return arrivals;
  });

  noteWithdrawals(db, notes);

  for (const [venueId, delta] of unparked) wip.counted(db, venueId, delta);

  /**
   * **A file that arrived is a sighting however it was found.** A probe found
   * this one by asking about a key nothing listed, which is weaker evidence
   * about the venue and exactly as good about the file — so both bounds move
   * on it, as they would for a walk, and for every venue whose keys are
   * generated rather than listed.
   */
  for (const one of answered) {
    sawFile(db, one.seriesId, one.date);
  }

  return moved;
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
 * double-count its partition.
 */
export const markDownloaded = (
  db:    DatabaseSync,
  files: readonly { venueId: number; path: string }[],
  at:    string,
): number => {
  if (files.length === 0) return 0;

  const pending = db.prepare(
    `SELECT ${ROW} FROM file WHERE venue_id = ? AND path = ? AND downloaded_at IS NULL`,
  );

  const mark = db.prepare(
    `UPDATE file SET downloaded_at = ?
      WHERE venue_id = ? AND path = ? AND downloaded_at IS NULL`,
  );

  return inTransaction(db, () => {
    const effects: FileEffect[] = [];

    for (const { venueId, path } of files) {
      const row = pending.get(venueId, path) as Row | undefined;

      // Already marked, or never catalogued. Either way there is nothing to
      // move and nothing to count.
      if (! row) continue;

      mark.run(at, venueId, path);

      effects.push({
        was: stateOf(row.partitionId, row.existence, row.size, row.etag, null),
        now: stateOf(row.partitionId, row.existence, row.size, row.etag, at),
      });
    }

    cache.record(db, (effects));

    return effects.length;
  });
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
export const withdrawFile = (db: DatabaseSync, venueId: number, path: string, status?: number): boolean => {
  const current = db.prepare(CURRENT);

  const was = inTransaction(db, () => {
    const row = current.get(venueId, path) as Row | undefined;

    if (! row || row.existence === 'absent') return null;

    db.prepare(`UPDATE file SET existence = 'absent' WHERE venue_id = ? AND path = ?`)
      .run(venueId, path);

    cache.record(db, ([{
      was: stateOf(row.partitionId, row.existence, row.size, row.etag, row.downloadedAt),
      now: stateOf(row.partitionId, 'absent',      row.size, row.etag, row.downloadedAt),
    }]));

    return row;
  });

  if (! was) return false;

  noteWithdrawals(db, [{
    event: 'withdrawn', cause: 'report', venueId, path, date: was.date,
    size: was.size, etag: was.etag, downloaded: was.downloadedAt !== null,
    ...(status === undefined ? {} : { status }),
  }]);

  return true;
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
  const current = db.prepare(CURRENT);

  return inTransaction(db, () => {
    const was = current.get(venueId, path) as Row | undefined;

    if (! was) return false;

    if (replaced(observed, was))
      db.prepare(REVISE).run(venueId, path, seenAt, was.size, was.etag, was.modified, was.downloadedAt);

    const downloadedAt = downloaded ? seenAt : null;
    const size         = observed.size ?? was.size;

    db.prepare(
      `UPDATE file
          SET size = COALESCE(?, size), etag = COALESCE(?, etag),
              modified = COALESCE(?, modified), downloaded_at = ?
        WHERE venue_id = ? AND path = ?`,
    ).run(observed.size, observed.etag, observed.modified, downloadedAt, venueId, path);

    cache.record(db, ([{
      was: stateOf(was.partitionId, was.existence, was.size, was.etag, was.downloadedAt),
      now: stateOf(was.partitionId, was.existence, size, observed.etag ?? was.etag, downloadedAt),
    }]));

    return true;
  });
};

/**
 * Whether the catalog holds this path as a file, and not as a withdrawn one.
 *
 * One indexed lookup on a statement prepared once per database, so it can be
 * asked once per key across a whole period's worth of keys.
 */
export const isHeld = (db: DatabaseSync, venueId: number, path: string): boolean =>
  statement(db,
    `SELECT 1 FROM file WHERE venue_id = ? AND path = ? AND existence <> 'absent'`,
  ).get(venueId, path) !== undefined;

// ── Test access ───────────────────────────────────────────────────────────────

/**
 * The slice budget, so the test that asserts the loop turns over between
 * writers measures against the real figure rather than a copy of it that can
 * drift.
 */
export const _test_BREATH_MS = BREATH_MS;
