import { logger } from '@devvir/service-kit';
import { backfill } from './backfill';
import { atGrain, lastSettled, prevPeriod } from './dates';
import { labelOf, lanesFor } from './pace';
import { addTransform, patternsOf, recordSeries, seriesFor, updateSeries } from './catalog';
import { pool } from './pool';
import type { Adapter, Found, Grain, Instrument, Preambled, Publishing } from './types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * What an update does before it generates anything: ask the venue what it lists.
 *
 * **Probing can only ask about series that already exist**, so nothing an update
 * does will ever find a symbol listed since the last full pass. A walk finds one
 * by reading the index and a seed by having been built, and between those there
 * is only this. Without it a venue that lists a hundred pairs a month quietly
 * stops being current, one pair at a time, until somebody re-walks it.
 *
 * **It runs to completion before generation starts**, which is the one ordering
 * that matters: a series created halfway through a pass would be generated for
 * from a tip nothing had earned, and the scopes are read once when the job opens
 * anyway.
 *
 * Three things happen here and nothing else:
 *
 * 1. an instrument the venue lists that this catalog has no live series for gets
 *    one per shape, and a backfill to earn its tip
 * 2. an instrument it no longer lists has its series marked `delisted`
 * 3. anything it disagrees with us about too strongly stops the whole step
 */
export const preamble = async (
  db:      DatabaseSync,
  adapter: Adapter,
  venueId: number,
  now:     Date = new Date(),
): Promise<Preambled> => {
  const idle: Preambled =
    { listed: 0, created: 0, revived: 0, delisted: 0, found: 0, refused: false };

  /**
   * **Before anything else, because everything after it assumes a tip.**
   * Generation starts above one, so a row without one is skipped — and the next
   * reconciliation then hands it the *floor*, `OVERDUE_DAYS` ago, which is a tip
   * that can never go back and an archive that can never be reached.
   *
   * A seed may legitimately arrive without one: where a start is known there is
   * nothing to guess, and inventing a floor to satisfy an interface is a made-up
   * number in the data. So the guess is made here, once, from the one fact that
   * settles it — the period below a known start, which is exactly where
   * "everything at or below is settled" is true.
   */
  floorTips(db, adapter, venueId);

  if (! adapter.instruments) return idle;

  const listed = await adapter.instruments(db);

  if (listed.length === 0) {
    logger.warn({ venue: labelOf(adapter) },
      'Venue listed no instruments at all — nothing is created and nothing is retired');

    return { ...idle, refused: true };
  }

  const held = seriesFor(db, venueId);

  if (! agrees(adapter, listed, held)) return { ...idle, listed: listed.length, refused: true };

  /**
   * **Read once, before anything is created**, or the first series written
   * raises the maximum for the next and the floor walks itself forward.
   *
   * It is what the last completed pass is known to have covered, which is the
   * right place for a series nobody has read to start: a pass that has not run
   * for three weeks covered up to three weeks ago, and a series discovered now
   * should begin where that pass stopped rather than where today is.
   */
  const covered = coveredTo(held, now);
  const oldest  = held.reduce<string | null>(
    (low, one) => (one.first !== null && (low === null || one.first < low) ? one.first : low), null);

  const live  = new Set(listed.filter(one => one.live).map(one => key(one.market, one.symbol)));
  const known = new Map<string, Publishing[]>();

  /**
   * **A series on a retired pattern is dead for good, and none of this touches
   * it.** The pattern is the shape the venue stopped writing to — okx's plain
   * order-book tree, whose last file has a date on it — so nothing published
   * under it will ever appear again, whatever the instrument does. Relisting the
   * symbol does not bring the shape back.
   *
   * It is left out of both questions this map answers. It cannot be revived, and
   * it must not count as "this instrument already has a series": a symbol whose
   * only surviving row sits on a retired shape needs series on the current ones,
   * and reading that row as coverage is how it would silently never get them.
   */
  for (const row of held) {
    if (row.retiredAt !== null) continue;

    const at = key(row.market, row.symbol);

    known.set(at, [...(known.get(at) ?? []), row]);
  }

  const opened: Publishing[] = [];
  const out = { ...idle, listed: listed.length };

  /** Instruments the catalog had never met, as against the series they opened. */
  let met = 0;

  for (const one of listed) {
    if (! one.live) continue;

    const rows = known.get(key(one.market, one.symbol)) ?? [];

    /** Already being generated for, so there is nothing to discover. */
    if (rows.some(row => row.state === 'active')) continue;

    /**
     * **A relisting revives what is already there.** The archive under a symbol
     * that comes back is the same archive, so its series are reopened rather
     * than duplicated.
     *
     * **`last` is left alone**, because it is a measurement: the newest file
     * ever seen does not become untrue when the venue relists the instrument.
     * What reopens the series is `state`, which `open` reads first — so a
     * revived instrument is open again immediately, whatever its files last did.
     */
    if (rows.length > 0) {
      for (const row of rows) {
        opened.push(updateSeries(db, {
          ...row,
          state: 'active',
          tip:   floor(row.grain, covered, row.tip),
        }));

        out.revived++;
      }

      continue;
    }

    /**
     * **Before the series, because a series carries its transforms from the
     * moment it is written.** `insert` attaches whatever the table holds for the
     * instrument; a row written after it would sit in the table unread until
     * something reloaded the registry, and generation would spend that whole
     * time building keys on the pattern's defaults.
     *
     * **A default that is wrong is silent.** The key it builds is well formed
     * and the venue answers that it is not there, which is what a quiet
     * instrument looks like — so the series never finds a start and nothing says
     * why. This is the one place the answer is known: the listing that named the
     * instrument is what stated it.
     */
    met++;

    for (const row of one.transforms ?? [])
      addTransform(db, { venueId, market: one.market, symbol: one.symbol, ...row });

    for (const shape of patternsFor(db, adapter, venueId, one)) {
      const found: Found = {
        market:  shape.market,
        dataset: shape.dataset,
        ...(shape.variant ? { variant: shape.variant } : {}),
        pattern: shape.pattern,
        symbol:  one.symbol,
      };

      /**
       * **The archive's spelling, where the venue's own name is not it.** A walk
       * reads this off the path; a listing has no path, so the adapter is asked
       * — and asked per shape, because a venue can spell one instrument two ways
       * depending on the dataset. Without it a newly listed instrument generates
       * URLs under a name the archive does not use, and finds nothing until the
       * next walk corrects it.
       */
      const spelt = adapter.urlSymbolFor?.(found);

      opened.push(recordSeries(db, venueId,
        { ...found, ...(spelt && spelt !== found.symbol ? { urlSymbol: spelt } : {}) },
        { tip: floor(shape.grain, covered, null) }));

      out.created++;
    }
  }

  /**
   * **Only markets the venue answered about.** A list that covers spot and says
   * nothing of options is not a statement that the options are gone — and
   * treating it as one would retire a whole market on a venue whose API is
   * split across endpoints, which most of them are.
   */
  const spoke = new Set(listed.map(one => one.market.toLowerCase()));

  /**
   * **What the venue says, and only that.**
   *
   * This writes `state`, which records whether the venue still lists an
   * instrument. It says nothing about where the series *ended*: a venue that has
   * stopped listing a symbol has not withdrawn its archive, and how long to keep
   * asking a quiet series for files is `open`'s question, from bounds the files
   * themselves wrote.
   *
   * A series on a retired pattern is left out: the shape is finished whatever
   * the instrument does.
   *
   * **So is a venue-wide file, and for a stronger reason: it is not an
   * instrument, so no listing can ever name it.** Its absence is guaranteed
   * rather than informative, and reading that absence as a delisting retires the
   * dataset itself every single pass. Nothing here can say anything about a
   * bucket — whether one has stopped is a question for the files, which is what
   * `last` and `open` already answer. Buckets are never delisted.
   */
  for (const row of held) {
    if (row.retiredAt !== null) continue;
    if (! row.pattern.includes('{SYMBOL}')) continue;
    if (! spoke.has(row.market.toLowerCase())) continue;

    const state = live.has(key(row.market, row.symbol)) ? 'active' : 'delisted';

    if (row.state === state) continue;

    updateSeries(db, { ...row, state });

    if (state === 'delisted') out.delisted++;
  }

  /**
   * **Every series the catalog has never read earns its tip rather than being
   * handed one**, which is one request where the instrument is as new as it
   * looks and the only way its history is ever reached where it is not — see
   * `backfill`.
   *
   * **Only where nothing has established a start.** A backfill walks *down* from
   * the floor to find where a series begins, which is work already done for any
   * series with a `first` on record: the archive below it has been read, and
   * asking again re-probes years to re-find files that are already catalogued.
   *
   * That distinction was missing, and revived series went through it too. When
   * gate's tradfi market was being wrongly delisted and revived twice a day, each
   * revival re-walked hundreds of symbols back to their beginnings — one of them
   * 28 months, for an archive a walk had read the day before.
   *
   * A revived series that never published *is* included, which is the case the
   * walk exists for: a symbol relisted after a gap has history below the floor
   * that nothing else will ever reach.
   */
  const walking = opened.filter(one => one.first === null);

  /**
   * **Between the listing and the summary there is nothing else to read.** A
   * walk is one request per period per series and runs to whatever `lanesFor`
   * allows, so a pass that met a few hundred instruments is quiet for minutes
   * and a first pass over a venue is quiet for far longer. The counts are all
   * settled by here, so saying them costs nothing and the silence stops being a
   * question.
   */
  if (met > 0 || out.revived > 0)
    logger.info({ venue: labelOf(adapter), instruments: met, series: out.created,
      revived: out.revived, walking: walking.length },
      'New instruments listed — their series are written, and each is now walked '
      + 'down from its floor to find where it begins');

  await pool(walking, lanesFor(adapter), async (row) => {
    out.found += (await backfill(db, adapter, row, covered, oldest ?? '19700101')).found;
  });

  return out;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Give a tip to every series of this venue that has a start and no tip.
 *
 * **One period below the start, which is the only place it can go.** Nothing was
 * published before a series began, so the period under its first file is exactly
 * where "everything at or below this is settled" is true — and generation runs
 * from `tip + 1`, so a tip placed *at* the start would skip the archive's own
 * first file.
 *
 * **A row with neither is a fault, not a case to handle.** A walk states a tip
 * from the first file it sees, a seed states a start or a floor or both, and the
 * preamble states one for anything it creates. A row with no tip and no start
 * came from none of those, so it is reported and left alone rather than given a
 * date nothing supports.
 */
const floorTips = (db: DatabaseSync, adapter: Adapter, venueId: number): void => {
  const missing = seriesFor(db, venueId).filter(one => one.tip === null);

  if (missing.length === 0) return;

  const stranded = missing.filter(one => one.first === null);

  for (const row of missing)
    if (row.first !== null)
      updateSeries(db, { ...row, tip: prevPeriod(atGrain(row.first, row.grain), row.grain) });

  if (missing.length > stranded.length)
    logger.info({ venue: labelOf(adapter), series: missing.length - stranded.length },
      'Series arrived with a start and no tip — floored one period below it');

  if (stranded.length > 0)
    logger.error({
      venue:   labelOf(adapter),
      series:  stranded.length,
      example: `${stranded[0]!.market} ${stranded[0]!.symbol}`,
    }, 'Series have neither a tip nor a start, so nothing says where to begin asking — '
     + 'they are not generated for and nothing here can repair them');
};

/**
 * The shapes a newly listed instrument gets a series for.
 *
 * **A market can be more than one archive, and an instrument lives in one of
 * them.** Binance's perpetual swaps are two products on two endpoints written to
 * two trees, `futures/um` and `futures/cm`, and both are `perp` here — rightly,
 * since both are perpetual swaps and a consumer asking for `perp` wants both.
 * That collapse belongs to answering questions. Creating series is the other
 * direction, and there the two are separate keyspaces: a contract domiciled in
 * one of them can never have a key in the other.
 *
 * Left unfiltered, every newly listed perp got a series under both trees — 130
 * of them describing keys that market has never held, each one a request a day
 * for ever, because a series that has never published has no end to reach and
 * nothing retires it.
 *
 * **Both sides have to say something, or nothing is refused.** The adapter names
 * the category a pattern's keyspace serves and the listing carries the category
 * it was found under; where either is silent every pattern is offered, so a
 * venue with one archive per market is untouched and a venue that splits without
 * saying so behaves exactly as it did rather than quietly losing series.
 *
 * Nothing is inferred from the symbol. The endpoint that listed a contract *is*
 * its domicile, and it is known at the moment it is read.
 */
const patternsFor = (
  db:      DatabaseSync,
  adapter: Adapter,
  venueId: number,
  one:     Instrument,
): Publishing[] =>
  patternsOf(db, venueId, one.market).filter((shape) => {
    /**
     * **A shape with no `{SYMBOL}` cannot be branched by symbol.**
     *
     * This preamble exists to discover instruments and give each one its series.
     * A pattern that never spells a symbol has nothing to branch on: every
     * instrument handed one generates the identical sequence of keys, so the
     * series are the same series wearing different names. Venue-wide files are
     * the case — one object per period carrying every instrument of a market at
     * once — and there the dataset *is* the file. It is carried by the market's
     * `@` series, which a walk or a seed makes; there is nothing left for an
     * instrument to be given.
     *
     * **What it costs to allow is not a duplicate, it is a scramble.** `file` is
     * unique on `(venue_id, path)` and settles with `DO NOTHING`, so those series
     * do not collide — they *partition* the dataset, each date landing on
     * whichever asked first, and none of them holding it all.
     *
     * Measured on okx, where four series shared `allswap-fundingrates`: they held
     * 1,693 distinct dates between them and **not one date twice**. The `@`
     * series had 11 of them; `PONS-USDT`, listed weeks earlier, had 1,660 and so
     * appeared to have five years of funding history it never had.
     */
    if (! shape.pattern.includes('{SYMBOL}')) return false;

    const serves = adapter.categoryOf?.(shape.pattern) ?? null;

    return serves === null || one.category === undefined || serves === one.category;
  });

/**
 * Where a series nobody has read starts being asked about.
 *
 * **Written when the row is, not when the backfill returns.** A series created
 * with no tip is one generation skips and the next preamble never revisits — it
 * is active by then, so it reads as already discovered. A pass killed between
 * the two would have stranded it for good.
 *
 * The backfill does not move it. It walks *down* from here recording what it
 * finds, so this is the tip either way and setting it up front costs nothing.
 *
 * Forward only, as everywhere else: a relisted series keeps a tip that is
 * already above the floor rather than being dragged back over settled ground.
 */
const floor = (grain: Grain, covered: Date, had: string | null): string => {
  const at = lastSettled(grain, covered);

  return had !== null && had > at ? had : at;
};

/**
 * How much of what a venue lists this catalog must already hold before anything
 * is acted on.
 *
 * **Half, because a venue does not relist itself overnight.** A busy week adds
 * tens of instruments to a venue that holds thousands, so anything close to a
 * clean split is not new listings — it is the adapter spelling instruments
 * differently from the files.
 *
 * Stated in one direction only. An archive holds thousands of symbols a venue
 * stopped listing years ago, so requiring the reverse would refuse everywhere.
 */
const AGREEMENT = 0.5;

/**
 * Whether the venue's names and the archive's are the same names at all.
 *
 * **The one failure that is silent and total.** If an adapter reports
 * instruments spelled differently from the files — `btcusdt` where the archive
 * writes `BTC-USDT` — then every instrument reads as new, and this step would
 * create a duplicate set of series *and* mark every real one delisted, with
 * nothing in the log to say it had happened.
 *
 * So it is checked before anything is written, and a venue that fails it is left
 * exactly as it was.
 */
const agrees = (adapter: Adapter, listed: readonly Instrument[], held: readonly Publishing[]): boolean => {
  const known = new Set(held.map(one => key(one.market, one.symbol)));

  /** Nothing to disagree with: no walk and no seed has run, so anything goes. */
  if (known.size === 0) return true;

  const spoke = listed.filter(one => one.live);

  if (spoke.length === 0) return true;

  const met   = spoke.filter(one => known.has(key(one.market, one.symbol)));
  const ratio = met.length / spoke.length;

  if (ratio >= AGREEMENT) return true;

  logger.error({
    venue:   labelOf(adapter),
    listed:  spoke.length,
    matched: met.length,
    known:   known.size,
    example: spoke.find(one => ! known.has(key(one.market, one.symbol)))?.symbol,
  }, 'Most of what this venue lists is a symbol the archive has never held — the adapter is '
   + 'spelling them differently from the files, so nothing is created and nothing is retired');

  return false;
};

/** One instrument, as both sides of the comparison have to spell it. */
const key = (market: string, symbol: string): string =>
  `${market.toLowerCase()} ${symbol}`;

/**
 * The newest date the venue is known to have been covered to.
 *
 * Tips of different grains sit in one column, so they are compared as instants
 * rather than as strings: a monthly `202607` means the first of that month, and
 * a daily `20260715` the day itself.
 */
const coveredTo = (held: readonly Publishing[], now: Date): Date => {
  let newest = 0;

  for (const row of held) {
    if (row.tip === null) continue;

    const at = Date.UTC(+row.tip.slice(0, 4), +row.tip.slice(4, 6) - 1, +(row.tip.slice(6, 8) || 1));

    if (at > newest) newest = at;
  }

  return newest === 0 ? now : new Date(newest);
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_coveredTo = coveredTo;
