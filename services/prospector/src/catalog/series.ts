import { logger } from '@devvir/service-kit';
import { atGrain, dueAt, lastSettled } from '../dates';
import { transformFor, transformsOf } from './transform';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Found, Grain, Publishing, Reconciled, SeriesCount, SeriesFilter, Slots } from '../types';

/**
 * What a venue publishes: the URL shapes, and the instruments occupying them.
 *
 * **Two tables because they change at different rates.** A venue adds symbols
 * weekly and changes the shape of a URL once in years, so `pattern` holds the
 * shapes — a handful of rows, effectively frozen — and `series` holds one row
 * per instrument per shape, with its bounds and its tip. Keeping them together
 * meant a new symbol could only be added by something that knew how to build
 * that venue's URLs, which is knowledge an adapter then had to carry for ever.
 *
 * **This module is the only thing that touches either.** Adapters and the core
 * report what they find and ask for what they need; nobody reads or writes the
 * rows directly.
 *
 * **Held in memory, because it is small.** Series are bounded by instruments,
 * datasets and patterns — tens of thousands per venue, where *files* are
 * millions. That bound is what makes `recordSeries` affordable on a path running
 * once per discovered file.
 *
 * **It writes its own tips out**, on a full buffer or a quiet interval, so no
 * caller has to own a schedule for it. The only call from outside is the one it
 * cannot schedule: a flush on shutdown.
 */

/**
 * Report what a path turned out to be, and get the series it belongs to.
 *
 * The hot call — once per discovered file — so it answers from memory and writes
 * nothing that is not new. A series already known is the ordinary case and costs
 * a map lookup.
 *
 * **It says nothing about the tip.** Being handed a path is not the same as
 * having an answer about it: a probing venue's keys arrive here invented, and
 * moving the tip on one of them would retire a period nobody has asked the venue
 * about. Tips are not written here at all: a walk states one when it finishes
 * the index, an update when it drains its queue.
 *
 * `bounds` is for a caller that knows more than a sighting does — a listing,
 * which states a start without a file, and a walk, which states all three.
 */
export const recordSeries = (
  db:      DatabaseSync,
  venueId: number,
  found:   Found,
  bounds?: Partial<Publishing>,
): Publishing => {
  const held = registry(db);
  const key  = identity(venueId, found);
  const had  = held.byKey.get(key);

  if (had) return had;

  const row = insert(db, venueId, found, bounds);

  held.byKey.set(key, row);
  held.byId.set(row.id!, row);

  return row;
};

/**
 * Record what probing established about one series.
 *
 * **Bounds and lifecycle only.** Which pattern a series belongs to and which
 * instrument occupies it cannot move — a different one of either is a different
 * series — so this updates a row that already exists and nothing else.
 *
 * The tip is one of the bounds it writes: a caller that measures where a series
 * starts is stating that nothing below that start will be asked about again.
 */
export const updateSeries = (db: DatabaseSync, series: Publishing): Publishing => {
  const held = registry(db);
  const row  = held.byId.get(series.id!);

  if (! row) return series;

  statements(db, held).update.run(series.first, series.last, series.tip,
    series.state, row.id!);

  Object.assign(row, {
    first:  series.first,
    last:   series.last,
    tip:    series.tip,
    state:  series.state,
  });

  return row;
};

/**
 * How far each venue has got, per series: how many hold a file, out of how many
 * there are.
 *
 * **Read from the bounds, not from the file table.** Asking `file` how many
 * series it holds rows for is a group-by over hundreds of millions of rows, on
 * an endpoint something polls. Both bounds are already in memory.
 *
 * **Both of them, because one alone is a bound a seed can state.** A start with
 * no end is where okx's seed leaves every series — a floor to probe up from, with
 * nothing found yet — and counting those would report a venue as complete before
 * it had answered anything. The pair is what a file actually produces: `sawFile`
 * writes both, from the same sighting.
 *
 * The tip cannot answer this at all. It no longer moves per file, so it sits at
 * the floor its seed gave it until a walk finishes or a pass drains — which on a
 * venue mid-probe is exactly when somebody is watching.
 *
 * **Every venue in one pass**, because the caller wants every venue: the
 * alternative is `seriesFor` per venue, filtering half a million rows and
 * allocating the survivors, once per venue, per poll.
 *
 * Keyed by venue id rather than by name — one venue can be several servers, and
 * which totals belong together is the caller's question, not this one's.
 */
export const seriesCounts = (db: DatabaseSync): Map<number, SeriesCount> => {
  const counts = new Map<number, SeriesCount>();

  for (const row of registry(db).byKey.values()) {
    let held = counts.get(row.venueId);

    if (! held) counts.set(row.venueId, held = { withFiles: 0, total: 0 });

    held.total++;

    if (row.first !== null && row.last !== null) held.withFiles++;
  }

  return counts;
};

/**
 * Every series of a venue, each carrying the pattern it belongs to.
 *
 * `only` narrows here rather than at the caller, because generation asks for
 * exactly "what is still worth pursuing" and would otherwise walk every retired
 * row of every departed symbol.
 */
export const seriesFor = (
  db:      DatabaseSync,
  venueId: number,
  only?:   SeriesFilter,
): Publishing[] => {
  /**
   * **An explicit empty set asks for nothing, and is answered with nothing.**
   * An absent filter asks for everything. The two are only confusable if the
   * emptiness is computed, which is exactly when getting it wrong hands back a
   * whole venue in place of the one instrument somebody named.
   */
  const symbols = only?.symbols?.map(one => one.toLowerCase());

  return [...registry(db).byKey.values()].filter(row =>
    row.venueId === venueId
    && (! only?.live
      || row.retiredAt === null)
    && (! only?.symbol  || row.symbol  === only.symbol)
    && (! symbols       || symbols.includes(row.symbol.toLowerCase()))
    && (! only?.market  || same(row.market,  only.market))
    && (! only?.dataset || same(row.dataset, only.dataset))
    && (! only?.variant || same(row.variant, only.variant))
    && (! only?.grain   || row.grain === only.grain));
};

/**
 * One series by its id, from memory.
 *
 * **The hot lookup for a listing**, which resolves a file's market, dataset and
 * instrument per row. Series are bounded by instruments and shapes — tens of
 * thousands per venue, where files are millions — which is what makes answering
 * this from a map affordable on a path that runs once per file.
 */
export const seriesById = (db: DatabaseSync, id: number): Publishing | undefined =>
  registry(db).byId.get(id);

/**
 * The series a path belongs to, where one already exists.
 *
 * **A lookup, never a creation**, which is what makes it the update's call. An
 * update generates its keys from the series it already has, so a key that reads
 * back as something unknown is a disagreement between the rule that wrote the
 * URL and the rule that reads it — and inventing a row to hold it would bury
 * that rather than leave it visible. Series are created by a walk, by a seed,
 * and by the update's preamble, all of which know more than a path does.
 */
export const seriesOf = (
  db:      DatabaseSync,
  venueId: number,
  found:   Found,
): Publishing | undefined =>
  registry(db).byKey.get(identity(venueId, found));

/**
 * The shapes a venue currently publishes a market under.
 *
 * **What a newly discovered instrument gets a series for**, one each. A pattern
 * is a shape rather than an instrument, so the answer is the same for every
 * symbol of that market and costs a pass over a table already in memory.
 *
 * **Retired shapes are left out, and that is the whole of the rule.** A venue
 * that moves its files — okx put its order books under `pro/L2/` and stopped
 * writing the old tree on a known day — leaves a pattern that is history rather
 * than a shape anything new will publish to. Creating a series there would
 * manufacture the one thing nothing retires: a row with no files, probed every
 * day for ever. So `pattern.state` has to be written wherever that happens, and
 * this is what reads it.
 */
export const patternsOf = (db: DatabaseSync, venueId: number, market: string): Publishing[] => {
  const seen = new Set<number>();
  const out: Publishing[] = [];

  for (const row of registry(db).byKey.values()) {
    if (row.venueId !== venueId || row.retiredAt !== null) continue;
    if (! same(row.market, market) || seen.has(row.patternId)) continue;

    seen.add(row.patternId);
    out.push(row);
  }

  return out;
};

/**
 * Whether this catalog still expects files for a series.
 *
 * **The one definition of open, because generating and being open are the same
 * question.** A series is open when we still expect files for it, and we
 * generate keys for exactly the series we still expect files for. Stated twice
 * they would drift, and the drift is silent in both directions: an "open" shape
 * nothing asks about, or a shape reported closed while requests are still going
 * out for it every day. So generation calls this, the API calls this, and
 * neither owns it.
 *
 * Three ways to still expect something, and one that ends it:
 *
 * | | |
 * |---|---|
 * | **listed, on a live shape** | open. The venue still trades it and still writes this shape, which outweighs any quiet spell |
 * | **nothing seen yet** | open. There is no measurement to call it finished on — this is every newly listed instrument, between its series being created and the archive's first file |
 * | **never asked about** | closed. A row with a `last` and no tip has been asked nothing, so there is no window to judge its silence in |
 * | **otherwise** | open while its newest file is inside the patience window, closed once it falls out |
 *
 * **A gap is not an ending while the tip is under `last`**, because a file was
 * seen up there and everything below it is still owed. That is what carries a
 * backfill across a quiet fortnight years in the past, where `state` describes
 * only today and nothing in the row says whether the instrument was listed then.
 *
 * **The shape has to be live, not just the instrument.** htx's old tree,
 * bitget's two dead naming eras and okx's pre-`pro/L2/` books are 132,397 series
 * whose instruments are alive and whose shapes are finished. Reading the
 * instrument alone would keep every one of them generating to yesterday for
 * ever, which is the whole reason a retired pattern is recorded.
 *
 * **The patience is measured from the tip, so this needs no clock.** The tip is
 * how far the venue has actually been asked, which is the only thing a silence
 * can be judged against — a wall clock would call a series closed over a
 * fortnight nobody spent asking, which is a statement about this service rather
 * than about the venue. Reconciliation keeps lifting the tip to `OVERDUE_DAYS`
 * ago, so the window comes out at about two of them: a month for a daily shape,
 * a month and a half for a monthly one. That figure is arbitrary and
 * deliberately so — it is nothing more than how long to keep asking a venue for
 * files it has stopped writing.
 */
export const open = (series: Publishing): boolean => {
  if (series.state === 'active' && series.retiredAt === null) return true;

  if (series.last === null) return true;

  if (series.tip === null) return false;

  return series.last >= lastSettled(series.grain, new Date(dueAt(series.tip, series.grain)));
};

/**
 * Retire every series of one symbol.
 *
 * **Per symbol, never per pattern.** An adapter that has compared the venue's
 * instrument listing knows an instrument has gone; which shapes carried it is
 * this module's business — and the shapes are untouched, since a pattern
 * outlives every instrument that ever used it.
 *
 * Nothing is deleted. A row is a measurement, and a measurement does not stop
 * being true because the instrument stopped trading.
 */
export const retireSeries = (
  db:      DatabaseSync,
  venueId: number,
  symbol:  string,
  state:   'delisted' = 'delisted',
): number => {
  const rows = seriesFor(db, venueId, { symbol }).filter(row => row.state === 'active');

  if (rows.length === 0) return 0;

  const set = statements(db, registry(db)).state;

  db.exec('BEGIN');

  try {
    for (const row of rows) set.run(state, row.id!);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');

    throw err;
  }

  for (const row of rows) row.state = state;

  return rows.length;
};

/**
 * Retire a shape the venue has stopped serving, as of the last date it served.
 *
 * The series under it keep everything they measured — what was published there
 * was published — and go on being generated for **up to that date and no
 * further**. okx moving its order books under `pro/L2/` is exactly this.
 *
 * **The date is the whole of the value.** A shape that merely says "stopped"
 * still has every one of its series asked about every day since, once, on the
 * pass that discovers them. Nothing can measure the date afterwards either: a
 * missing file and a tree that has ended answer identically, so it is declared
 * where the shape itself is declared.
 */
export const retirePattern = (db: DatabaseSync, patternId: number, at: string): void => {
  db.prepare('UPDATE pattern SET retired_at = ? WHERE id = ?').run(at, patternId);

  for (const row of registry(db).byId.values())
    if (row.patternId === patternId) row.retiredAt = at;
};

/**
 * Record what a walk saw: the series the file belongs to, and its bounds.
 *
 * **The one entry point a walk uses**, because a walk is the source of truth and
 * a sighting is the whole of what it has to say. The file that creates a series
 * is also the first thing known about it, so the bounds are written by the same
 * call that writes the row — not left null for a later pass to fill in, which is
 * how a series ends up on disk claiming to have no start.
 *
 * **A walk reads none of the three bounds to decide anything.** It never skips a
 * period, stops early, or refuses a file because of a `first`, a `last` or a
 * `tip`. It reads the index and states what is there; the bounds are its output.
 *
 * Two rules, stated from the creating file and then kept up as the walk meets
 * the rest:
 *
 * ```
 * first := min(first, d)
 * last  := max(last, d)
 * ```
 *
 * **The tip is not among them, because it is not a per-file claim.** What a walk
 * proves about a tip it proves by reading the index to the end, not by meeting
 * any particular file: every period at or below `since - OVERDUE_DAYS` was
 * offered and answered. That is one value for the whole walk, and `settleWalk`
 * states it once when the last partition closes.
 *
 * A series this walk *creates* is the exception, and it is an initialisation
 * rather than an update: generation refuses a series with no tip at all, so a
 * new row starts at that same edge — or at its own file, where that is newer.
 *
 * **`last` is the newest date seen and nothing more.** A walk reads an index
 * and records what it says; it is not a claim that the archive stopped there,
 * and nothing is inferred from it here.
 *
 * Monotonic, like the other two, so nothing here depends on meeting a series'
 * files in date order — which an index does not guarantee across hours and
 * partitions.
 */
export const walkSeries = (
  db:      DatabaseSync,
  venueId: number,
  found:   Found,
  date:    string,

  /**
   * When the walk began.
   *
   * **The walk's own start, not the clock**, so a walk that runs for days
   * measures dormancy against one fixed moment and cannot decide that a series
   * died halfway through reading it.
   */
  since:   Date,
): Publishing => {
  const held  = registry(db);
  const grain = grainOf(found.pattern);
  const at    = atGrain(date, grain);
  const floor = walkEdge(grain, since);

  const had = registry(db).byKey.get(identity(venueId, found));

  /**
   * **A new series states all three from the file that found it.** The file
   * that created the row is the oldest and the newest one known of it, so both
   * bounds are that date, and the tip starts no lower than the walk's edge.
   */
  if (! had)
    return recordSeries(db, venueId, found, {
      first: at,
      tip:   at > floor ? at : floor,
      last:  at,
    });

  const first = had.first === null || at < had.first ? at : had.first;
  const last  = had.last  === null || at > had.last  ? at : had.last;

  // The ordinary case on a large venue: the thousandth file of a series says
  // nothing the first nine hundred did not.
  if (first === had.first && last === had.last) return had;

  had.first = first;
  had.last  = last;

  touch(held, had);

  return had;
};

/**
 * Where a walk's tips start, per grain, worked out once rather than per file.
 *
 * A constant for the length of a walk, and `walkSeries` runs once per discovered
 * file — millions of them on a large venue. There is no invalidation to get
 * wrong: a walk's start does not move, and a second walk asks under its own key.
 */
const walkEdge = (grain: Grain, since: Date): string => {
  const key = `${grain} ${since.getTime()}`;
  const had = EDGES.get(key);

  if (had !== undefined) return had;

  const made = lastSettled(grain, since);

  EDGES.set(key, made);

  return made;
};

const EDGES = new Map<string, string>();

/**
 * What reading an index to the end is worth to the tips of the venue it indexes.
 *
 * **One statement over every series, not a claim per file.** A walk that closed
 * every partition offered the whole keyspace as it stood at `since`; a period it
 * never named was not published, whatever series it would have belonged to. So
 * the tip every series earns is the same date — the settled edge of the walk's
 * own start — and a series the walk never mentioned earns it exactly as much as
 * one it mentioned a thousand times.
 *
 * **This is the walk's reconciliation, and it is the only one it gets.** An
 * update earns its tips by draining a queue and hands them to `reconcile`; a
 * walk earns them by finishing the index, and nothing about the clock can add to
 * that. Both lift, neither lowers.
 *
 * **Only on a walk that finished**, which the caller decides — the same rule as
 * `reconcile`, for the same reason. A walk that stopped with a partition unread
 * has offered part of a keyspace and proved nothing about the rest, and a tip
 * does not come back.
 */
export const settleWalk = (db: DatabaseSync, venueId: number, since: Date): number => {
  const held = registry(db);

  let lifted = 0;

  for (const row of seriesFor(db, venueId)) {
    const edge = walkEdge(row.grain, since);

    if (row.tip !== null && row.tip >= edge) continue;

    row.tip = edge;
    touch(held, row);
    lifted++;
  }

  flushTips(db);

  return lifted;
};

/**
 * Record that a file of this series exists, and how old and how new it is.
 *
 * **Both edges, because both are the same claim.** A file at a date proves the
 * series reached back at least that far and forward at least that far; which of
 * the two it moves is arithmetic, not a different kind of evidence. So a
 * sighting writes `first` down and `last` up, and neither ever goes the other
 * way.
 *
 * **The tip is not a sighting, which is why it is not here.** A tip is a
 * contiguous frontier and refuses to jump a gap; these two take whatever they
 * are given, hole or no hole. Folding the tip in would either bury gaps under it
 * or stop `last` recording a file that arrived above one.
 *
 * **The update's half of a measurement the walk already made.** A walk states
 * bounds from every file it reads; an update states none, because a generated
 * key is a guess until something answers for it. This is where it stops being a
 * guess: a probe that found the file is a sighting as good as a listing's, and
 * without it neither bound ever moved on a venue that cannot be walked — which
 * is what left okx and bitget with files going back months under a NULL
 * `first`, waiting on a reconciliation to notice.
 *
 * **Writing `first` here cannot strand the range below it**, which is the thing
 * to check before believing that. `first` floors *generation*, and the keys
 * below it are already parked — in `wip`, on disk, surviving a restart — so
 * they go on being probed whatever the floor says, and anything they find lowers
 * it again. What a start bounds is the asking that has not happened yet.
 *
 * An absence is not a sighting and never reaches here — those go to
 * `missedFiles`.
 */
export const sawFile = (db: DatabaseSync, seriesId: number, date: string): void => {
  const held = registry(db);
  const row  = held.byId.get(seriesId);

  if (! row) return;

  const at    = atGrain(date, row.grain);
  const first = row.first === null || at < row.first ? at : row.first;
  const last  = row.last  === null || at > row.last  ? at : row.last;

  // The ordinary case: the thousandth file of a series says nothing the first
  // nine hundred did not.
  if (first === row.first && last === row.last) return;

  row.first = first;
  row.last  = last;

  touch(held, row);
};


/**
 * What a completed update pass is worth to the series it generated for.
 *
 * **Three statements, run once, over a pass that actually finished.** The pass
 * generated every URL it owed and drained its queue, so what is left in the
 * record is answers: every file the venue holds inside the window was found, and
 * every period it did not answer for is absent rather than pending. Spending
 * that is what stops a quiet series asking for a wider range every day, for ever.
 *
 * **Bounds are checked here, not written here.** A sighting states them as the
 * file arrives — see `sawFile` — and that remains the only thing that moves one
 * during a pass. What this adds is the reading back: once the archive has been
 * measured, every bound is compared against the files that justify it, and one
 * that cannot be justified is replaced.
 *
 * **Because outward-only is not enough on its own.** Every other path widens a
 * bound and none of them narrows one, since each is holding a single file and a
 * single file can only extend a range. So a withdrawal lowers nothing when it
 * happens, and the row goes on claiming a date the catalog itself has marked
 * absent. This is the one place that can put it right, and it is deliberately
 * the *last* thing a pass does rather than a second writer running beside the
 * first.
 *
 * **Only after a pass that finished**, which the caller decides. A pass that was
 * blocked, paused, or gave up returns normally and has checked nothing; lifting
 * its tips would assert that the last `OVERDUE_DAYS` were asked about when they
 * were not — permanently, since a tip never goes back, and unrecoverably on a
 * venue with no walk to refresh it.
 */
export const reconcile = (
  db:      DatabaseSync,
  venueId: number,
  now:     Date = new Date(),
): Reconciled => {
  const held    = registry(db);

  /**
   * **What the files say about one series.**
   *
   * Bounds are written as each file is seen — see `sawFile` — and that is where
   * they come from in the ordinary case. This is the catch-all behind it: a pass
   * that has finished asking reads them back off the archive it just measured,
   * so whatever else wrote a bound, what stands at the end is what the files
   * hold. Without it a bound is only ever as good as every path that touches it,
   * and one of those is a withdrawal, which lowers no bound today.
   *
   * **No answer means the series holds no file at all**, which is the other
   * thing this loop needs to know. Asking once settles both.
   *
   * **Asked per series rather than per venue**, because a venue is not a
   * question `file` can answer cheaply and does not need to be: which series
   * belong to this venue is already in hand, one line below. Each call is a seek
   * into `file_series` and a walk of that series' own entries, and `existence`
   * is in the index so none of it reaches a row.
   */
  const bounds = db.prepare(
    `SELECT min(date) AS first, max(date) AS last
        FROM file
       WHERE series_id = ? AND existence <> 'absent'`,
  );

  const summary: Reconciled = { lifted: 0, removed: 0, corrected: 0 };

  for (const row of seriesFor(db, venueId)) {
    const floor = lastSettled(row.grain, now);

    /**
     * **1. Every tip to the floor.** This is what retires an absence for good,
     * and it does so without anyone having tracked which series had a gap: a
     * real hole, a transient miss that settled later, and the dead range below a
     * newly listed instrument's true start all go the same way.
     */
    if (row.tip === null || row.tip < floor) {
      row.tip = floor;
      touch(held, row);
      summary.lifted++;
    }

    /**
     * **A series with no files is not a measurement, so the row goes** — whatever
     * the venue currently lists. A pass that finished asked every period this
     * series covers and the archive answered for none of them; there is no start,
     * therefore no end, and nothing left for the row to say.
     *
     * **The listing has no bearing on it.** An instrument the venue lists today
     * that has never published is exactly as empty as one it has forgotten, and
     * keeping the row costs `OVERDUE_DAYS` of keys a day for as long as that
     * stays true. Where the shape itself is retired it stays true for ever: a
     * venue that stopped writing a naming will not resume it, so a series with no
     * files under one can never acquire any.
     *
     * **Deleting is self-correcting, which is what makes it safe.** If the symbol
     * is still listed on a live shape, the next preamble creates the series again
     * and backfills it; find files and they stick, find none and it is deleted
     * again, until the day something publishes. If the symbol is gone, or the
     * shape is retired, nothing recreates it — `patternsOf` refuses a retired
     * pattern to a new instrument — and it stays gone, which is the point.
     *
     * **Asked of `file`, not of `first`.** The two agree now that a sighting
     * writes the start, and the column would be the cheaper read — but they
     * agree only for rows written since it did. A catalog still carrying series
     * from before that, files and all, would have them deleted wholesale by a
     * reader that trusted the column. The file table cannot be wrong about this.
     */
    const real = bounds.get(row.id!) as { first: string | null; last: string | null };

    if (real.first === null) {
      remove(db, held, row);
      summary.removed++;

      continue;
    }

    /**
     * **The bounds are set to what the files hold, not merely widened to it.**
     *
     * Everywhere else a bound only moves outward, because everywhere else the
     * evidence is one file and one file can only ever extend a range. Here the
     * evidence is the whole series, so a bound that has come to disagree with it
     * is simply wrong and is replaced — which is the only way one ever comes
     * back in. A file the venue has withdrawn is the case that needs it: nothing
     * lowers a bound when it goes, so without this the series would go on
     * claiming a date the catalog itself records as absent.
     */
    if (row.first !== real.first || row.last !== real.last) {
      row.first = real.first;
      row.last  = real.last;

      touch(held, row);
      summary.corrected++;
    }

    /**
     * **Nothing is retired here.** A quiet series is not a delisted one, and
     * what counts as quiet enough to stop asking is `open`'s question, answered
     * from the row every time it is asked rather than written down here as a
     * verdict that could go stale.
     */
  }

  flushTips(db);

  return summary;
};

/**
 * Write out the bounds that have moved since the last flush.
 *
 * **A walk must flush before its cursor advances**, and `sweep` is what enforces
 * that. A page whose files are committed and whose cursor moves on, while the
 * bounds derived from them sit in this buffer and are then lost, leaves a series
 * whose `first` is quietly later than the truth — and nothing afterwards
 * re-reads the page that would have corrected it.
 *
 * Within that, the debounce is free: a buffer lost between page boundaries costs
 * nothing, because the page is re-listed and rewritten from its cursor.
 */
export const flushTips = (db: DatabaseSync): number => {
  const held = registry(db);

  if (held.timer) {
    clearTimeout(held.timer);
    held.timer = null;
  }

  if (held.moved.size === 0) return 0;

  const set = statements(db, held).bounds;

  /**
   * **A caller may already be inside a transaction**, and the seed migration is:
   * every migration runs in one. Opening a second would throw, so the batch
   * joins the one already open and is committed with it.
   */
  const joined = (db as { isTransaction?: boolean }).isTransaction === true;

  if (! joined) db.exec('BEGIN');

  try {
    for (const id of held.moved) {
      const row = held.byId.get(id)!;

      set.run(row.first, row.last, row.tip, id);
    }

    if (! joined) db.exec('COMMIT');
  } catch (err) {
    if (! joined) db.exec('ROLLBACK');

    throw err;
  }

  const written = held.moved.size;

  held.moved.clear();

  return written;
};

/**
 * Read both tables into memory, once per database.
 *
 * Everything after this is served from what it built, so no caller ever waits on
 * SQLite to learn whether a series is known.
 */
export const loadSeries = (db: DatabaseSync): number => {
  const had = REGISTRIES.get(db);

  if (had?.timer) clearTimeout(had.timer);

  const held: Registry = {
    db, byKey: new Map(), byId: new Map(), patterns: new Map(),
    moved: new Set(), timer: null, sql: null,
  };

  REGISTRIES.set(db, held);

  for (const row of readPatterns(db))
    held.patterns.set(patternKey(row.venueId, row.market, row.dataset, row.pattern),
      { id: row.id, retiredAt: row.retiredAt });

  /**
   * **Copied out of the driver's rows, and repeated values shared.**
   *
   * Two independent costs, both paid once here. A row as `node:sqlite` hands it
   * over retains 1,280 bytes against 544 for an ordinary object holding the same
   * values; and the columns that come from the pattern have a few hundred
   * distinct values between them, so they want one string each rather than one
   * per series. Measured over 282,000 series, the registry falls from 392 MB to
   * 114 MB — the rest of it is the two maps and their keys.
   *
   * The pool is local, so nothing outlives the registry it was built for.
   */
  const pool = new Map<string, string>();

  const shared = <T extends string | null>(value: T): T => {
    if (value === null) return value;

    const had = pool.get(value);

    if (had !== undefined) return had as T;

    pool.set(value, value);

    return value;
  };

  for (const row of read(db)) {
    const series = {
      ...row,
      market:       shared(row.market),
      dataset:      shared(row.dataset),
      variant:      shared(row.variant),
      pattern:      shared(row.pattern),
      grain:        shared(row.grain),
      retiredAt:    shared(row.retiredAt),
      symbol:       shared(row.symbol),
      state:        shared(row.state),
      first:        shared(row.first),
      last:         shared(row.last),
      tip:          shared(row.tip),
    } as unknown as Publishing;

    /**
     * Only where there is something to attach. Almost no instrument of almost
     * any venue has a transform, and a field on every row of a registry this
     * size is paid for whether it holds anything or not.
     */
    const exceptions = transformsOf(db, row.venueId, row.market, row.symbol);

    if (exceptions) series.transforms = exceptions;

    held.byKey.set(identity(series.venueId, series), series);
    held.byId.set(series.id!, series);
  }

  return held.byId.size;
};

/**
 * How often a pattern publishes.
 *
 * **The only place a grain is written down.** A shape with `{HH}` is a file an
 * hour, one with `{DD}` a file a day, one with neither a file a month — so
 * storing it beside the pattern would be a second copy of the same fact, free to
 * disagree with the first.
 */
export const grainOf = (pattern: string): Grain => {
  for (const [ending, period] of SLOT_GRAIN) if (pattern.includes(ending)) return period;

  return 'monthly';
};

/**
 * How a slot name declares its grain: by ending in it, finest first.
 *
 * Matching the **ending** rather than the whole name is what lets an adapter
 * invent a slot without the catalog learning its cadence separately — gate's
 * `{EPOCH_HH}` is hourly for the same reason `{HH}` is. A pattern naming both an
 * hour and a day is hourly, as it must be: the day alone would not identify the
 * file.
 */
const SLOT_GRAIN: [string, Grain][] = [
  ['MI}', 'minutely'],
  ['HH}', 'hourly'],
  ['DD}', 'daily'],
];

/**
 * One key: the pattern with an instrument and a stamp put into it.
 *
 * **The whole of building a URL.** Everything else in a pattern is literal, and
 * the archive's spelling of the instrument was settled when the row was written
 * — so nothing here has to ask an adapter anything.
 *
 * The stamp is as wide as the series' own grain — `202608`, `20260803` or
 * `2026080314` — and a slot the pattern does not carry costs nothing, so one
 * expression serves all three.
 *
 * **The calendar is all this knows.** A venue whose paths want something else —
 * bybit naming a month by both its ends, gate naming a file by the instant it
 * covers — hands those slots over through its own `slotsFor`, so an oddity costs
 * that adapter a function rather than costing every venue a vocabulary.
 */
export const keyOf = (series: Publishing, at: string, slots?: Slots): string => {
  let key = (series.pattern.includes('{TRANSFORM:') ? substituted(series, at) : series.pattern)
    .replaceAll('{SYMBOL}', series.urlSymbol ?? series.symbol)
    .replaceAll('{YYYY}', at.slice(0, 4))
    .replaceAll('{MM}', at.slice(4, 6))
    .replaceAll('{DD}', at.slice(6, 8))
    .replaceAll('{HH}', at.slice(8, 10))
    .replaceAll('{MI}', at.slice(10, 12));

  if (slots) for (const [slot, value] of Object.entries(slots(at))) key = key.replaceAll(slot, value);

  return key;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * `{TRANSFORM:kind:default}`, where the default may itself be a slot.
 *
 * The kind runs to the first colon; everything after it is the default, which is
 * allowed one level of braces so `{TRANSFORM:archiveDir:{SYMBOL}}` parses.
 */
const TRANSFORM = /\{TRANSFORM:([^:}]+):((?:[^{}]|\{[^{}]*\})*)\}/g;

/**
 * The pattern with its transforms resolved, **before any slot is filled**.
 *
 * A row substitutes what the venue actually uses; where there is no row the
 * default stands, and since that default is ordinarily `{SYMBOL}` the result
 * rejoins the normal path and generation cannot tell the two apart. That is the
 * point: one shape serves the instruments that follow the rule and the handful
 * that do not.
 */
const substituted = (series: Publishing, at: string): string =>
  series.pattern.replaceAll(TRANSFORM, (_, kind: string, fallback: string) =>
    transformFor(series.transforms, series.dataset, kind, at) ?? fallback);

/**
 * What is held for one open database.
 *
 * `moved` is the debounce: the ids whose tip has advanced in memory and not yet
 * on disk. `patterns` is how a reported shape finds its id without a query.
 */
interface Registry {
  /** The database these rows came from, so a self-scheduled flush can reach it. */
  db:       DatabaseSync;

  byKey:    Map<string, Publishing>;
  byId:     Map<number, Publishing>;
  patterns: Map<string, { id: number; retiredAt: string | null }>;
  moved:    Set<number>;

  /** The pending quiet-interval flush, if one is owed. */
  timer:    NodeJS.Timeout | null;

  sql:      Statements | null;
}

interface Statements {
  pattern:  StatementSync;
  insert:   StatementSync;
  update:   StatementSync;
  state:    StatementSync;

  /** The one place a series row is removed — see `remove`. */
  drop:     StatementSync;
  bounds:   StatementSync;

}

/**
 * The statements, prepared once.
 *
 * **Because inserting is a per-row path.** The shipped seed is twenty-two
 * thousand rows in one go, and preparing the same SQL for each of them turned
 * opening a catalog from about a second into more than ten.
 */
const statements = (db: DatabaseSync, held: Registry): Statements =>
  held.sql ??= {
    pattern: db.prepare(
      `INSERT INTO pattern (venue_id, market, dataset, variant, pattern, grain)
            VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue_id, market, dataset, pattern) DO NOTHING
         RETURNING id`,
    ),

    insert: db.prepare(
      `INSERT INTO series (pattern_id, symbol, url_symbol,
                           first, last, tip, state)
            VALUES (?, ?, ?, ?, ?, ?, ?)
       -- A self-assignment of half the conflict key, so the row is untouched and
       -- RETURNING still yields its id. DO NOTHING would return no row at all,
       -- and every caller here needs the id of the series it just named.
       --
       -- The key is the name the keys carry rather than the symbol, matching
       -- identity() -- see there for why. COALESCE also settles the NULL
       -- convention: a url_symbol spelled out and one left implicit are the same
       -- series, and collide as they should.
       ON CONFLICT (pattern_id, COALESCE(url_symbol, symbol))
       DO UPDATE SET pattern_id = excluded.pattern_id
         RETURNING id`,
    ),

    update: db.prepare(
      `UPDATE series
          SET first = ?, last = ?, tip = ?, state = ?
        WHERE id = ?`,
    ),

    state: db.prepare('UPDATE series SET state = ? WHERE id = ?'),
    drop:  db.prepare('DELETE FROM series WHERE id = ?'),
    bounds: db.prepare('UPDATE series SET first = ?, last = ?, tip = ? WHERE id = ?'),

  };

/**
 * Per database rather than per process: a service opens one and the tests open
 * several. Keyed on the handle, so nothing has to be threaded through callers.
 */
const REGISTRIES = new WeakMap<DatabaseSync, Registry>();

/**
 * **Built on first use, and never silently.**
 *
 * Loading it reads every series of every venue and costs seconds — measured at
 * 3.6 against 282,000 of them — and `node:sqlite` is synchronous, so nothing
 * else in the process runs while it happens. Whoever asks first pays, which is
 * whatever survey or request happened to arrive first and looks from outside
 * exactly like a service that has wedged.
 *
 * It stays lazy because a catalog is not always surveyed: a process that only
 * serves reads has no reason to hold half a gigabyte it will never consult. What
 * it must not do is disappear for seconds without saying so.
 */
const registry = (db: DatabaseSync): Registry => {
  const held = REGISTRIES.get(db);

  if (held) return held;

  logger.info('Loading the series registry — nothing else runs until it is built');

  const started = Date.now();
  const series  = loadSeries(db);

  logger.info({ series, seconds: Math.round((Date.now() - started) / 100) / 10 },
    'Series registry loaded');

  return REGISTRIES.get(db)!;
};

/**
 * Whether two of a venue's own names are the same name.
 *
 * **Case-blind, because the venues are not consistent with themselves.** Okx
 * shouts `SWAP` where gate whispers `spot`, and a caller naming a market should
 * not have to remember which. It hides some of the inconsistency between venues
 * without pretending to resolve it.
 */
const same = (held: string, asked: string): boolean =>
  held.toLowerCase() === asked.toLowerCase();

/**
 * What makes two series the same series: the shape, and the name its keys carry.
 *
 * **Not the symbol.** A series exists to generate URLs, so the question asked of
 * this — during a walk that has just read a path, and when an adapter names the
 * series of a newly listed instrument — is only ever "is there already a series
 * that yields these URLs?". Two rows resolving to one name under one pattern
 * generate the same keys, which is what being one series means, whatever symbol
 * either carries. And one instrument's files can legitimately move to a new name
 * partway through its life, or appear under two at once, which is two series
 * under the symbol a consumer asks by.
 *
 * A walk has the name directly, since it read it out of the path. An adapter
 * naming series for a new instrument states it, and must: without it there is no
 * URL to generate.
 */
const identity = (
  venueId: number,
  of:      {
    market: string; dataset: string; pattern: string;
    symbol: string; urlSymbol?: string | null;
  },
): string =>
  [venueId, of.market, of.dataset, of.pattern, of.urlSymbol ?? of.symbol].join(' ');

const patternKey = (venueId: number, market: string, dataset: string, pattern: string): string =>
  [venueId, market, dataset, pattern].join(' ');

/**
 * Take a series out of the catalog and out of the registry that mirrors it.
 *
 * **Both, or the registry serves a row the database no longer has.** Reads are
 * answered from memory here, so a row deleted only in SQLite would go on being
 * generated for, and a tip it still held would be flushed as an `UPDATE` against
 * an id that is gone — silently doing nothing, which is the worst of the three.
 * Dropping it from `moved` is what stops that last one.
 *
 * No dependants to consider: `file` and `wip` both reference `series`, and
 * reconciliation only deletes a row with neither — one that never published, at
 * a moment when the pass that generated for it has drained.
 */
const remove = (db: DatabaseSync, held: Registry, row: Publishing): void => {
  statements(db, held).drop.run(row.id!);

  held.moved.delete(row.id!);
  held.byId.delete(row.id!);
  held.byKey.delete(identity(row.venueId, row));
};

/**
 * Mark a series' bounds as owed to disk, and decide when that gets written.
 *
 * One dirty set for all three bounds, because one statement writes them: a
 * second would be a second thing to forget to flush.
 */
const touch = (held: Registry, row: Publishing): void => {
  held.moved.add(row.id!);

  if (held.moved.size >= FLUSH_AT) {
    flushTips(held.db);

    return;
  }

  /**
   * **Unreferenced, so a pending flush never holds the process open.** What it
   * would be keeping alive is at most ten seconds of tip movement, and losing
   * that costs probes rather than files — where a service that will not exit is
   * a real problem.
   */
  if (held.timer) return;

  /**
   * **A flush that arrives after the database has gone is not an error.** The
   * timer is unreferenced so it cannot hold the process open, which means it can
   * also fire into a connection something else has already closed — a test
   * tearing down, a service exiting between the schedule and the deadline.
   *
   * Losing it costs probes rather than files, exactly as missing the flush
   * altogether would, so it is swallowed rather than allowed to surface as an
   * unhandled failure with nothing anybody can do about it.
   */
  held.timer = setTimeout(() => {
    try {
      flushTips(held.db);
    } catch {
      // The connection went away first; the tips it held are re-derived by the
      // next pass asking about periods it has already catalogued.
    }
  }, FLUSH_AFTER).unref();
};

/**
 * How much movement is allowed to go unwritten.
 *
 * **Whichever comes first.** A walk advances thousands of tips a minute and hits
 * the count long before the interval; an update touching a handful of series
 * would otherwise sit unwritten indefinitely. Neither number is delicate —
 * losing either only costs probes.
 */
const FLUSH_AT    = 1_000;
const FLUSH_AFTER = 10_000;

/** The pattern's id and whether it has ended, creating the shape if it is new. */
const patternIdOf = (
  db:      DatabaseSync,
  venueId: number,
  found:   Found,
): { id: number; retiredAt: string | null } => {
  const held = registry(db);
  const key  = patternKey(venueId, found.market, found.dataset, found.pattern);
  const had  = held.patterns.get(key);

  if (had !== undefined) return had;

  const made = statements(db, held).pattern.get(
    venueId, found.market, found.dataset, found.variant ?? '',
    found.pattern, grainOf(found.pattern)) as { id: number } | undefined;

  /**
   * `DO NOTHING` returns nothing when the row was already there — because
   * something else wrote it after this process loaded the table, or because a
   * **seed** did, which is how a walked venue learns that a shape it is about to
   * meet has already ended. So the read has to bring `retired_at` back with the
   * id: a series created against that shape is on a dead tree from its first
   * moment, and would otherwise claim to be on a live one until the next reload.
   */
  const row: { id: number; retiredAt?: string | null } = made ?? db.prepare(
    `SELECT id, retired_at AS retiredAt FROM pattern
      WHERE venue_id = ? AND market = ? AND dataset = ? AND pattern = ?`,
  ).get(venueId, found.market, found.dataset, found.pattern) as
    { id: number; retiredAt: string | null };

  const shape = { id: row.id, retiredAt: row.retiredAt ?? null };

  held.patterns.set(key, shape);

  return shape;
};

const insert = (
  db:      DatabaseSync,
  venueId: number,
  found:   Found,
  bounds?: Partial<Publishing>,
): Publishing => {
  const shape = patternIdOf(db, venueId, found);

  const row: Publishing = {
    venueId,
    patternId:    shape.id,
    market:       found.market,
    dataset:      found.dataset,
    variant:      found.variant ?? '',
    pattern:      found.pattern,
    grain:        grainOf(found.pattern),
    retiredAt:    shape.retiredAt,
    symbol:       found.symbol,

    /**
     * **Whatever the finder observed**, falling back to the venue's own name —
     * which is correct for every venue whose archive spells instruments the way
     * its listing does, and that is most of them.
     */
    urlSymbol:    found.urlSymbol ?? null,
    first:        bounds?.first ?? null,
    last:         bounds?.last  ?? null,
    tip:          bounds?.tip   ?? null,
    state:        bounds?.state ?? 'active',
  };

  const { id } = statements(db, registry(db)).insert.get(
    shape.id, row.symbol, row.urlSymbol, row.first, row.last, row.tip,
    row.state) as { id: number };

  /**
   * **Asked here for the same reason `loadSeries` asks**: a key is built from
   * the series alone, so a row created now with its transforms left off would
   * generate against the pattern's defaults until something reloaded the
   * registry — which on a service that stays up is never.
   *
   * Only where there is something to attach, as on the loading path: almost no
   * instrument of almost any venue has one.
   */
  const exceptions = transformsOf(db, venueId, row.market, row.symbol);

  return { ...row, id, ...(exceptions ? { transforms: exceptions } : {}) };
};

interface Row extends Omit<Publishing, 'found'> {
  found: number;
}

/**
 * Every series with the pattern it belongs to, exactly as the driver hands them
 * over.
 *
 * **Not reshaped here.** `found` is an integer because SQLite has no boolean,
 * and converting it in a `.map()` allocated a second copy of every row — a
 * whole extra pass over half a million objects the caller is about to walk
 * anyway. `loadSeries` converts it in the loop it already runs.
 *
 * **Ordered by `s.id`, which costs nothing.** It is the INTEGER PRIMARY KEY, so
 * the scan already produces that order and there is no sort to do. Ordering by
 * anything else — this read used to lead with `p.venue_id` — cannot be answered
 * from an index and puts all half a million joined rows through a temp B-tree
 * first: measured at **17.7s against 0.9s**, for an ordering nothing reads. The
 * registry is two maps and the only two places that iterate it are filters.
 */
const read = (db: DatabaseSync): Row[] =>
  db.prepare(
    `SELECT s.id, s.pattern_id AS patternId, s.symbol, s.url_symbol AS urlSymbol,
            s.first, s.last, s.tip, s.state,
            p.venue_id AS venueId, p.market, p.dataset, p.variant, p.pattern,
            p.grain, p.retired_at AS retiredAt
       FROM series s JOIN pattern p ON p.id = s.pattern_id
      ORDER BY s.id`,
  ).all() as unknown as Row[];

interface PatternRow {
  id: number; venueId: number; market: string; dataset: string; variant: string;
  pattern: string; grain: Grain; retiredAt: string | null;
}

const readPatterns = (db: DatabaseSync): PatternRow[] =>
  db.prepare(
    'SELECT id, venue_id AS venueId, market, dataset, variant, pattern, grain,'
    + ' retired_at AS retiredAt FROM pattern')
    .all() as unknown as PatternRow[];

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_identity = identity;
