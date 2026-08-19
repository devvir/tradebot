import { keyFor, grainOf, open, seriesById, seriesFor } from './catalog';
import { logger } from '@devvir/service-kit';
import { atGrain, instant, lastClosed, lastSettled, nextPeriod } from './dates';
import type { Grain, Listed, Page, Publishing, Slots } from './types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Finding what a venue has published since we last looked, without reading a
 * listing.
 *
 * **Every venue ends up here.** An indexed one maps itself by walking, and once
 * that walk is behind it there is nothing left for a listing to tell it: the
 * shapes are known, the instruments are known, and what is wanted is the next
 * file of each. One that cannot be listed at all — okx, bitget — starts here,
 * because declaring its series is the only way it could ever have started.
 *
 * So this is not a second scanner. It is the same walk over a keyspace nobody
 * has to fetch: **one scope per series, and the dates between its tip and today
 * substituted into its pattern.** The scopes and cursors are the ordinary ones,
 * which is what makes an update stoppable and resumable exactly like a walk.
 *
 * **Nothing here discovers.** These keys are built from series the catalog
 * already holds, so a symbol listed this morning has to arrive some other way —
 * from a walk, a seed, or the preamble asking the venue what it lists.
 */

/**
 * The scopes an update walks: one per series still worth pursuing.
 *
 * **`open` is the whole test**, and it is the same function the API answers with:
 * a series is open when this catalog still expects files for it, and keys are
 * generated for exactly the series it still expects files for. One concept, one
 * definition — see `open` in `catalog/series.ts`.
 *
 * The id is the scope, because a series is the smallest thing an update can
 * generate independently — and unlike a prefix it cannot be subdivided, so the
 * refinement that a listing walk needs has nothing to do here.
 */
export const updateScopes = (db: DatabaseSync, venueId: number): string[] =>
  live(db, venueId).map(one => String(one.id));

/**
 * One page of candidate keys for a series, resuming from a cursor.
 *
 * **From the tip, bounded by the series' own ends.** The tip is the claim that
 * everything at or below it is settled, so generation starts at the period after
 * it — whether that tip came from a walk reading the index, a seed measuring the
 * archive, or the last update's own reconciliation.
 *
 * ```
 * START := max(tip + 1, first)                    first ignored where NULL
 * END   := min(last complete period, retired_at)  retired_at ignored where NULL
 * ```
 *
 * The last complete period is yesterday for a daily shape, last month for a
 * monthly one. Today's file is unfinished rather than late, and tomorrow's is
 * not a candidate at all. Both bounds clamp the range rather than skipping the
 * series — see `above` and `under`.
 *
 * **`last` is not one of the bounds, and must not become one.** It says where the
 * archive was last *witnessed* to reach, which is a floor under what exists
 * rather than a ceiling over it — capping generation there would stop a series
 * ever being extended. Where it speaks is `open`, which decides whether this
 * series is generated for at all, and — on a first pass over a seeded venue —
 * the span below.
 *
 * **One span may be left out of the middle**, and only there. A seed that
 * recorded a series' newest file also establishes, by having gone on looking
 * until the day it was written, that nothing followed it up to that day. So
 * where `Rules.seededAt` is given, `[last + 1, seededAt - OVERDUE_DAYS]` is
 * jumped: below `last` is ordinary history and above the horizon the instrument
 * may have resumed, but between them is measured absence. Everything else about
 * the range is unchanged, and without a seeded horizon there is no span at all.
 *
 * **Nothing here knows about gaps**, deliberately. A hole in a series' history
 * is discovered by probing what this emits, and a run of absences neither stops
 * the range nor shortens it: at this distance a gap and an ending are the same
 * shape, and only the dates above it can tell them apart.
 */
export const updatePage = (
  db:       DatabaseSync,
  venueId:  number,
  scope:    string,
  cursor:   string | null,
  rules?:   Rules,
  now:      Date = new Date(),
): Page => {
  /**
   * **One series, by id, from the map that already holds it.**
   *
   * A scope names exactly one series, so asking which of a venue's are still
   * live in order to find it rebuilt and filtered the whole set — every series
   * of every venue — once per page. The tests that decide it are per-row, so
   * they are applied to the row.
   */
  const series = seriesById(db, Number(scope));

  if (! series || series.venueId !== venueId || ! generable(series))
    return { listed: [], cursor: null };

  const from = above(series, cursor, series.grain);
  const upto = under(series.grain, now, series.retiredAt);

  /**
   * **The span a seed already proved empty**, or nothing where no seed says so.
   *
   * A seeded `last` is the newest file a seed-building pass found; that pass
   * went on looking up to the day it was built, so everything between the two is
   * measured absence rather than an assumption. Skipping it is the difference
   * between a first pass that asks about the whole calendar and one that asks
   * about the parts nobody has answered for.
   *
   * **Only the middle.** Below `last` is ordinary history, gaps and all. Above
   * the seed's own horizon the instrument may have resumed, and the fortnight
   * under that horizon was never settled even then — so the tail is asked about
   * like any other.
   */
  const skip = rules?.seededAt && series.last
    ? { from: nextPeriod(atGrain(series.last, series.grain), series.grain),
        to:   lastSettled(series.grain, new Date(instant(rules.seededAt))) }
    : null;

  const listed: Listed[] = [];

  for (let at = from; at <= upto; at = nextPeriod(at, series.grain)) {
    /**
     * **Jumped, not filtered.** Landing on `to` lets the loop's own step carry
     * past it, so a five-year span costs one comparison rather than eighteen
     * hundred decisions to emit nothing.
     */
    if (skip && at >= skip.from && at <= skip.to) { at = skip.to; continue; }

    listed.push({
      key:      keyFor(series, at, rules?.slots),
      size:     null,
      etag:     null,
      modified: null,

      /** Built from this series, so nothing downstream needs to work it out. */
      seriesId: series.id!,
    });

    if (listed.length >= PAGE) return { listed, cursor: at };
  }

  return { listed, cursor: null };
};

/**
 * What one venue does differently, as far as generating a key is concerned.
 *
 * The adapter's, and optional because most venues need nothing here: `slots` is
 * for a path that is not simply a calendar. How the archive spells an instrument
 * is not among them — that is recorded on the series itself.
 */
export interface Rules {
  slots?: Slots;

  /**
   * When this venue's seed was built, where one built it — see `seriesSeededAt`.
   *
   * **Only set while a first pass is owed on a venue nothing can list.** Its
   * whole use is the span below: a seed that recorded a series' newest file also
   * establishes, by having looked, that nothing followed it up to this date. On
   * any other pass it is absent and generation is a plain range.
   */
  seededAt?: string;
}


// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * How many keys a page carries.
 *
 * A thousand, to match what an S3 listing returns — not because anything here is
 * limited to it, but because everything downstream is sized for pages of that
 * order: one transaction, one cursor write, one progress line.
 */
const PAGE = 1_000;

/**
 * Every series this venue is still worth asking about.
 *
 * **`open` is the whole test**, asked per row — see `generable`, which is what
 * `updatePage` applies to the single series a scope names.
 *
 * **A tip is an invariant, not a condition.** A walk states one from the first
 * file it sees, a seed states one below the archive's start, and the preamble
 * states one for anything it creates — so a series without one is a row written
 * by something that no longer exists. It is skipped and counted rather than
 * generated from `first`, which is the guess this design removed.
 *
 * **A series with no symbol is one of them.** okx's venue-wide files carry every
 * instrument of a market at once, so their patterns have no `{SYMBOL}` slot and
 * generating one is a date and nothing else — no different from here.
 */
const live = (db: DatabaseSync, venueId: number): Publishing[] => {
  /**
   * **A retired pattern still generates.** Retirement says the venue stopped
   * writing that shape, which is a statement about what will be *created* —
   * the preamble gives a newly listed instrument no series on a dead shape —
   * and not about what is already here. A series on a retired pattern whose end
   * has never been established is one this catalog still owes an answer for, and
   * refusing to generate for it is how it would never get one.
   *
   * Which series are worth generating for is `open`'s question and it is not
   * answered twice — see `catalog/series.ts`.
   */
  const rows = seriesFor(db, venueId).filter(one => open(one));
  const held = rows.filter(one => generable(one));

  if (held.length !== rows.length)
    logger.warn({ venue: venueId, series: rows.length - held.length },
      'Series with no tip are not generated for — nothing states a bound for them any more');

  return held;
};

/**
 * Whether one series is worth generating for, which is what `live` tests for a
 * whole venue and `updatePage` tests for the one it was handed.
 *
 * **Stated once so the two cannot drift.** A scope chosen by `live` and then
 * refused here would be a partition that opens, generates nothing and closes —
 * work that looks like progress and is not.
 *
 * **`open` is the whole of the question**, and it is shared with the API on
 * purpose: a series is open exactly when this catalog still expects files for
 * it, and it generates keys for exactly the series it still expects files for.
 * Those are one concept, so they are one function — see `open` in
 * `catalog/series.ts`. All this adds is the tip, which is not a judgement about
 * the venue but an invariant of the row: generation starts above a tip, so a
 * series without one has nowhere to start.
 */
const generable = (series: Publishing): boolean =>
  open(series) && series.tip !== null;

/**
 * Where generating starts: the period after the cursor or the tip, and never
 * below the series' own start.
 *
 * **The cursor names the last key emitted**, so generating begins at the period
 * after it rather than repeating it. The tip is treated the same way, and means
 * the same thing: a period already settled is not a candidate.
 *
 * **`first` is a floor, not a suggestion.** Nothing was published before a
 * series began, so a tip sitting under its start would spend the whole gap
 * asking about days that are known to hold nothing. In ordinary life the two
 * agree — a seed states `first - 1` and a walk never goes below what it saw — so
 * this changes nothing there. It matters for a seed that states a floor for a
 * whole dataset rather than for each series, which is exactly what a rebuild
 * does.
 */
const above = (series: Publishing, cursor: string | null, grain: Grain): string => {
  const from = nextPeriod(atGrain(cursor ?? series.tip!, grain), grain);

  /** A cursor is progress through this pass, so it always wins over the start. */
  if (cursor !== null || series.first === null) return from;

  const start = atGrain(series.first, grain);

  return start > from ? start : from;
};

/**
 * Where generating stops: the last period that can be complete.
 *
 * **`last` is not a ceiling, and must not become one.** Whether a quiet series
 * is asked about at all is `open`'s question; this one is only how far. A series
 * that is open is asked up to the frontier like any other, so the newest file
 * seen stays a measurement and capping the range there would stop a series ever
 * being extended.
 *
 * The bound is the last period that can be complete: yesterday for a daily
 * shape, last month for a monthly one. Today's file is unfinished rather than
 * late, and tomorrow's is not a candidate at all.
 *
 * **Except where the shape itself ended, which is a real ceiling.** A venue that
 * stopped writing a naming will not resume it, so nothing above `retired_at`
 * exists to be found and asking is spending requests to be told so. Without it
 * every series of a shape retired years ago is asked for every day since — once
 * each, on the pass that discovers them, which for bitget's superseded namings
 * is 21.6 M keys that can only ever answer 403.
 *
 * It cannot be inferred, only declared: a missing file and a tree that has ended
 * are the same answer from the archive. So it arrives with the shape, from the
 * seed that carries it.
 */
const under = (grain: Grain, now: Date, retiredAt: string | null): string => {
  const frontier = lastClosed(grain, now);

  if (retiredAt === null) return frontier;

  const ended = atGrain(retiredAt, grain);

  return ended < frontier ? ended : frontier;
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_grainOf   = grainOf;
