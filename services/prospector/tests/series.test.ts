import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  flushTips, loadSeries, open, parkKeys, putFiles, putVenue, recordSeries, reconcile,
  retirePattern, retireSeries, seriesFor, settleWalk, updateSeries, walkSeries,
} from '../src/catalog';
import { openCatalog } from '../src/database';
import { okx } from '../src/adapters/okx';
import type { Found, Publishing } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The table every file belongs to, and the one thing allowed to write it.
 *
 * What is worth pinning here is not the SQL but the three rules the rest of the
 * design leans on: a series is its pattern, a tip only moves forward, and a
 * lost flush costs probes rather than files.
 */

let dir: string;
let db:  DatabaseSync;
let id:  number;

const DAILY   = 'x/{YYYY}{MM}{DD}/{SYMBOL}.zip';
const MONTHLY = 'x/{YYYY}{MM}/{SYMBOL}.zip';

/**
 * `urlSymbol` is deliberately not defaulted. A series is identified by the name
 * its keys carry, so a fixture stating one here would have every instrument it
 * builds publish to the same URL — which is one series, not several.
 */
const at = (over: Partial<Found> = {}): Found => ({
  market: 'SPOT', dataset: 'trades', symbol: 'BTC-USDT',
  pattern: DAILY, ...over,
});

const record = (over: Partial<Found> = {}, bounds = {}) =>
  recordSeries(db, id, at(over), { first: '20240101', ...bounds });

/** One catalogued file of a series, which is what an answered period looks like. */
const catalogued = async (series: Publishing, date: string, path = `p/${date}`) =>
  putFiles(db, [{
    venueId: id, path, date, size: 1, etag: 'e', modified: null,
    existence: 'confirmed', seriesId: series.id!, seenAt: 'T1',
  }]);

/** What one sighting of a walk says, at a walk that began on `since`. */
const sighted = (date: string, since = new Date('2026-08-01T00:00:00Z'),
  over: Partial<Found> = {}) => walkSeries(db, id, at(over), date, since);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'series-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });
  id  = putVenue(db, 'demo', okx.base, okx.root);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('recording', () => {
  it('inserts once and is a no-op after that', () => {
    const first  = record();
    const second = record();

    expect(second.id).toBe(first.id);
    expect(seriesFor(db, id)).toHaveLength(1);
  });

  /**
   * **The point of two tables.** A second instrument under the same shape adds a
   * series and no pattern — which is what makes discovering a symbol cheap and
   * keeps an adapter from having to know how to build a URL.
   */
  it('reuses one pattern across every instrument that publishes to it', () => {
    record();
    record({ symbol: 'ETH-USDT', urlSymbol: 'ETH-USDT' });

    expect(seriesFor(db, id)).toHaveLength(2);

    // Scoped to this venue on purpose: an assertion about what recording did
    // must not depend on what else a catalog happens to carry.
    expect(db.prepare('SELECT count(*) n FROM pattern WHERE venue_id = ?').get(id))
      .toMatchObject({ n: 1 });
  });

  /**
   * **A pattern is what a series is.** The same data under a URL the venue
   * changed is a second row, not an edit of the first — which is how okx's order
   * books keep their settled history when the prefix moves.
   */
  it('treats a different pattern as a different series', () => {
    record();
    record({ pattern: 'x/pro/{YYYY}{MM}{DD}/{SYMBOL}.zip' });

    expect(seriesFor(db, id)).toHaveLength(2);
  });

  /** A rendering is a series of its own, with bounds and a tip of its own. */
  it('treats a rendering as a series of its own', () => {
    record();

    const month = record({ pattern: MONTHLY });

    expect(seriesFor(db, id)).toHaveLength(2);

    // The grain is read off the shape rather than stored beside it.
    expect(month.grain).toBe('monthly');
    expect(seriesFor(db, id).find(one => one.pattern === DAILY)!.grain).toBe('daily');
  });
});

/**
 * **A tip is a claim that a range was asked about, so no single file can move
 * one.** Two things earn that claim and both state it over a set of series at
 * once: a walk that read its index to the end, and an update that drained its
 * queue. Neither is a per-file writer, which is why cataloguing a file leaves
 * every tip exactly where it was.
 */
describe('tips', () => {
  /** OVERDUE_DAYS short of the walk, then the last day that had closed by then. */
  const WALKED = new Date('2024-01-31T00:00:00Z');
  const EDGE   = '20240115';

  it('are untouched by a file arriving', async () => {
    const row = record();

    await catalogued(row, '20240101');
    expect(seriesFor(db, id)[0]!.tip).toBe(null);

    await catalogued(row, '20240102');
    expect(seriesFor(db, id)[0]!.tip).toBe(null);
  });

  /**
   * **No contiguity to maintain, because nothing crawls.** A gap in what
   * arrived was a gap in the index too, and the walk that read it says so for
   * every series at once.
   */
  it('are settled by a walk that finished, gap or no gap', async () => {
    const row = record();

    await catalogued(row, '20240101');
    await catalogued(row, '20240104');

    expect(settleWalk(db, id, WALKED)).toBe(1);
    expect(seriesFor(db, id)[0]!.tip).toBe(EDGE);
  });

  /** Forward only: a walk that proves less than the tip already claims adds nothing. */
  it('are left alone by a walk whose edge is lower than the tip', async () => {
    const row = record({}, { tip: '20240220' });

    await catalogued(row, '20240101');

    expect(settleWalk(db, id, WALKED)).toBe(0);
    expect(seriesFor(db, id)[0]!.tip).toBe('20240220');
  });

  /** Each series at its own grain, since a month and a day close differently. */
  it('settle a monthly shape at a month and a daily one at a day', async () => {
    record({ pattern: 'p/{YYYY}{MM}.zip', symbol: 'M' });
    record({ symbol: 'D' });

    settleWalk(db, id, WALKED);

    const tips = Object.fromEntries(
      seriesFor(db, id).map(one => [one.grain, one.tip]));

    expect(tips).toEqual({ monthly: '202312', daily: EDGE });
  });

  /**
   * **Losing a flush costs probes, not files.** The tip on disk stays where it
   * was, so the next update asks about days already catalogued — wasteful, and
   * the only direction that is recoverable.
   */
  it('are written out when they are flushed', () => {
    record();

    // Scoped to this venue on purpose, so the row read back is this test's and
    // not whatever else a catalog happens to carry.
    const stored = () => db.prepare(
      `SELECT s.tip FROM series s JOIN pattern p ON p.id = s.pattern_id
        WHERE p.venue_id = ?`).get(id);

    expect(stored()).toMatchObject({ tip: null });

    // settleWalk flushes what it moved, since a tip nobody wrote out is a tip
    // the next pass does not have.
    settleWalk(db, id, WALKED);

    expect(stored()).toMatchObject({ tip: EDGE });

    // Nothing owed, so nothing written.
    expect(flushTips(db)).toBe(0);
  });

  it('read back when the table is loaded again', () => {
    record();

    settleWalk(db, id, WALKED);
    loadSeries(db);

    expect(seriesFor(db, id)[0]!.tip).toBe(EDGE);
  });
});

describe('retirement', () => {
  /**
   * **Per symbol, never per pattern.** An adapter knows an instrument has gone;
   * which patterns carried it is this table's business.
   */
  it('retires every series of a symbol at once', () => {
    record();
    record({ pattern: MONTHLY });
    record({ symbol: 'ETH-USDT', urlSymbol: 'ETH-USDT' });

    expect(retireSeries(db, id, 'BTC-USDT')).toBe(2);
    expect(seriesFor(db, id, { symbol: 'BTC-USDT' }).every(one => one.state === 'delisted'))
      .toBe(true);
    expect(seriesFor(db, id, { symbol: 'ETH-USDT' })[0]!.state).toBe('active');
  });

  /** A retired shape is what stops a series being generated for at all. */
  it('leaves rows on a retired pattern out of what is still worth pursuing', () => {
    const row = record({}, { first: null });

    retirePattern(db, row.patternId, '20240102');
    loadSeries(db);

    expect(seriesFor(db, id)).toHaveLength(1);
    expect(seriesFor(db, id, { live: true })).toHaveLength(0);
  });
});

describe('updating', () => {
  it('records what probing established without moving the identity', () => {
    const row = record({}, { first: null });

    updateSeries(db, { ...row, first: '20240201' });
    loadSeries(db);

    const [held] = seriesFor(db, id);

    expect(held).toMatchObject({ first: '20240201' });
    expect(seriesFor(db, id)).toHaveLength(1);
  });
});

/**
 * What a consumer names, and what it gets back.
 *
 * These are the vocabulary the whole service exists to offer — a caller says
 * `perp` `klines` at `1h`, monthly, for these instruments, and never learns how
 * the venue spells any of it. Absent means *any*; an explicit empty set means
 * none.
 */
describe('narrowing to what a consumer asked for', () => {
  /**
   * A variant lives in the path, so two of them are two patterns — which is why
   * these differ by their strings rather than by the `variant` alone. The
   * pattern table is keyed on the shape, and a venue that published two bar
   * lengths to one URL would not be publishing two series.
   */
  const HOURLY = 'x/trades/{YYYY}{MM}{DD}{HH}/{SYMBOL}.zip';
  const K1H_M  = 'x/klines/1h/{YYYY}{MM}/{SYMBOL}.zip';
  const K1H_D  = 'x/klines/1h/{YYYY}{MM}{DD}/{SYMBOL}.zip';
  const K15_M  = 'x/klines/15m/{YYYY}{MM}/{SYMBOL}.zip';

  beforeEach(() => {
    record({ dataset: 'klines', variant: '1h',  symbol: 'BTC-USDT', pattern: K1H_M });
    record({ dataset: 'klines', variant: '1h',  symbol: 'BTC-USDT', pattern: K1H_D });
    record({ dataset: 'klines', variant: '15m', symbol: 'BTC-USDT', pattern: K15_M });
    record({ dataset: 'klines', variant: '1h',  symbol: 'ETH-USDT', pattern: K1H_M });
    record({ dataset: 'trades', symbol: 'BTC-USDT', pattern: HOURLY });
  });

  it('matches a variant, so one bar length can be asked for alone', () => {
    expect(seriesFor(db, id, { variant: '1h' })).toHaveLength(3);
    expect(seriesFor(db, id, { variant: '15m' })).toHaveLength(1);
  });

  /**
   * The filter that separates two renderings of the same data. A venue filing
   * one month both monthly and daily hands a caller the same trades twice.
   */
  it('matches a grain, read off the shape rather than stored', () => {
    expect(seriesFor(db, id, { dataset: 'klines', grain: 'monthly' })).toHaveLength(3);
    expect(seriesFor(db, id, { dataset: 'klines', grain: 'daily' })).toHaveLength(1);
    expect(seriesFor(db, id, { grain: 'hourly' })).toHaveLength(1);
  });

  it('matches any of several instruments', () => {
    expect(seriesFor(db, id, { symbols: ['ETH-USDT'] })).toHaveLength(1);
    expect(seriesFor(db, id, { symbols: ['BTC-USDT', 'ETH-USDT'] })).toHaveLength(5);
  });

  /** The case is a spelling convention, not a fact about the instrument. */
  it('matches instruments case-blind, as it does market and dataset', () => {
    expect(seriesFor(db, id, { symbols: ['btc-usdt'] })).toHaveLength(4);
    expect(seriesFor(db, id, { market: 'spot', dataset: 'KLINES' })).toHaveLength(4);
  });

  /**
   * An empty set is a filter that matched nothing. Answering the whole venue
   * there would hand back every dataset it has to a request that named none.
   */
  it('answers nothing for an empty set, and everything for an absent one', () => {
    expect(seriesFor(db, id, { symbols: [] })).toHaveLength(0);
    expect(seriesFor(db, id, {})).toHaveLength(5);
  });

  it('composes, because a caller names several at once', () => {
    expect(seriesFor(db, id,
      { dataset: 'klines', variant: '1h', grain: 'monthly', symbols: ['BTC-USDT'] }))
      .toHaveLength(1);
  });
});

/**
 * What a walk states about a series, from the file in front of it.
 *
 * **The walk is the source of truth**, so it reads none of the three bounds to
 * decide anything and writes all three from what it sees. The rules are
 * order-independent, because an index yields a series' files in whatever order
 * its keyspace happens to run.
 */
describe('bounds a walk states', () => {
  /** A walk began here, so anything due before 2026-02-02 has been silent 180 days. */
  const SINCE = new Date('2026-08-01T00:00:00Z');

  /** OVERDUE_DAYS short of the walk, then the last day that had closed by then. */
  const FLOOR = '20260716';

  const DORMANT = '20250101';
  const QUIET   = '20260401';
  const RECENT  = '20260725';

  it('states all three from the file that created the series', () => {
    sighted(RECENT, SINCE);

    flushTips(db);

    const [held] = seriesFor(db, id);

    expect(held!.first).toBe(RECENT);
    expect(held!.tip).toBe(RECENT);
    expect(held!.last).toBe(RECENT);
  });

  it('pulls the start back and pushes the newest file forward', () => {
    sighted('20260720', SINCE);
    sighted(RECENT, SINCE);
    sighted('20260718', SINCE);

    flushTips(db);

    const [held] = seriesFor(db, id);

    expect(held!.first).toBe('20260718');
    expect(held!.last).toBe(RECENT);
  });

  /**
   * **The tip is stated once, when the index has been read to the end.** Every
   * sighting after the one that created the series leaves it alone: what a tip
   * claims is that a range was asked about, and meeting one more file of a
   * series is not evidence of that — see `settleWalk`.
   */
  it('leaves the tip where the creating sighting put it', () => {
    sighted('20260718', SINCE);
    sighted(RECENT, SINCE);

    flushTips(db);
    expect(seriesFor(db, id)[0]!.tip).toBe('20260718');
  });

  /**
   * **The floor is what the walk knows that the sighting does not.** Everything
   * between a series' newest file and the walk's own start was read and found
   * empty, so the first update has no business asking for any of it. Without
   * this, a series quiet for four months is four months of keys.
   */
  it('floors the tip at the walk edge for a series that has gone quiet', () => {
    sighted(QUIET, SINCE);

    flushTips(db);

    const [held] = seriesFor(db, id);

    expect(held!.first).toBe(QUIET);
    expect(held!.tip).toBe(FLOOR);
    expect(held!.last).toBe(QUIET);
  });

  it('leaves a tip above the floor where the series is still publishing', () => {
    sighted(RECENT, SINCE);

    flushTips(db);
    expect(seriesFor(db, id)[0]!.tip).toBe(RECENT);
  });

  it('carries the newest date forward across sightings', () => {
    sighted(DORMANT, SINCE);
    sighted('20250301', SINCE);

    flushTips(db);

    const [held] = seriesFor(db, id);

    expect(held!.last).toBe('20250301');
    expect(held!.first).toBe(DORMANT);
  });

  /**
   * **The newest date seen, and nothing inferred from it.** A walk reads an
   * index and records what it says; whether a silence is an ending needs to know
   * if the venue still lists the instrument, which only the preamble can ask.
   */
  it('records the newest date seen whichever order the files arrive in', () => {
    sighted(DORMANT, SINCE);
    sighted(RECENT, SINCE);

    sighted(RECENT, SINCE, { symbol: 'ETH-USDT' });
    sighted(DORMANT, SINCE, { symbol: 'ETH-USDT' });

    flushTips(db);

    const ends = Object.fromEntries(
      seriesFor(db, id).map(one => [one.symbol, one.last]));

    expect(ends).toEqual({ 'BTC-USDT': RECENT, 'ETH-USDT': RECENT });
  });

  /** Each series at its own grain, since a month and a day close differently. */
  it('records a monthly shape at its month', () => {
    sighted('20260715', SINCE, { pattern: MONTHLY });

    flushTips(db);

    const [held] = seriesFor(db, id);

    expect(held!.first).toBe('202607');
    expect(held!.tip).toBe('202607');
  });

  it('floors a monthly shape at a month and a daily one at a day', () => {
    sighted('20240101', SINCE, { pattern: MONTHLY, symbol: 'M' });
    sighted('20260401', SINCE, { pattern: DAILY,   symbol: 'D' });

    flushTips(db);

    const tips = Object.fromEntries(
      seriesFor(db, id).map(one => [one.grain, one.tip]));

    expect(tips).toEqual({ monthly: '202606', daily: FLOOR });
  });

  it('is a no-op once the bounds already cover the sighting', () => {
    sighted('20260718', SINCE);
    sighted(RECENT, SINCE);

    flushTips(db);

    sighted('20260720', SINCE);
    expect(flushTips(db)).toBe(0);
  });
});


/**
 * What a completed update pass is worth to the series it generated for.
 *
 * **The pass drained**, so every period it did not answer for is absent rather
 * than pending. Three statements spend that, in an order the third depends on.
 */
describe('reconciling a completed update', () => {
  const NOW = new Date('2026-08-01T00:00:00Z');

  /** OVERDUE_DAYS short of now, then the last day that had closed by then. */
  const EDGE = '20260716';

  const filed = async (series: Publishing, date: string) =>
    putFiles(db, [{
      venueId: id, path: `p/${series.id}/${date}`, date, size: 1, etag: 'e',
      modified: null, existence: 'confirmed', seriesId: series.id!, seenAt: 'T1',
    }]);

  /**
   * **Every series here carries a file**, and not incidentally: reconciliation
   * deletes one that has none, so a fixture without a file is a fixture that
   * does not survive to be asserted on. The date is far below the tip, where it
   * cannot move it and confuse what these are measuring.
   */
  const OLD = '20200101';

  it('lifts every tip to the settled edge', async () => {
    const row = record({}, { tip: '20260401' });

    await filed(row, OLD);

    expect(reconcile(db, id, NOW)).toMatchObject({ lifted: 1 });
    expect(seriesFor(db, id)[0]!.tip).toBe(EDGE);
  });

  /** A tip is a promise that nothing below is asked again, so it only rises. */
  it('leaves a series that answered inside the window alone', async () => {
    const row = record({}, { tip: '20260725' });

    await filed(row, OLD);

    expect(reconcile(db, id, NOW)).toMatchObject({ lifted: 0 });
    expect(seriesFor(db, id)[0]!.tip).toBe('20260725');
  });

  /**
   * **A sighting writes the bounds; this checks them.** The two are not a pair of
   * writers on different schedules — one states a bound as each file arrives, the
   * other reads every bound back off the files once a pass has finished asking.
   * A bound that disagrees with them was moved by something the archive does not
   * support, and a withdrawal is the ordinary way: it lowers nothing when it
   * happens, so without this the row goes on claiming a date the catalog itself
   * records as absent.
   */
  it('sets a start that disagrees with the files back to them', async () => {
    const bare = record({ symbol: 'BARE' }, { first: null, tip: '20260401' });
    const knew = record({ symbol: 'KNEW' }, { first: '20200101', tip: '20260401' });

    await filed(bare, '20260320');
    await filed(knew, '20260320');

    expect(reconcile(db, id, NOW)).toMatchObject({ corrected: 1 });

    const starts = Object.fromEntries(
      seriesFor(db, id).map(one => [one.symbol, one.first]));

    /** BARE was already what its file says; KNEW claimed six years it cannot show. */
    expect(starts).toMatchObject({ BARE: '20260320', KNEW: '20260320' });
  });

  /** Agreement is the ordinary case, and costs nothing to confirm. */
  it('corrects nothing where every bound matches its files', async () => {
    const row = record({ symbol: 'FINE' }, { first: null, tip: '20260401' });

    await filed(row, '20260320');

    expect(reconcile(db, id, NOW)).toMatchObject({ corrected: 0 });
  });

  /** Each series at its own grain, since a month and a day close differently. */
  it('lifts a monthly shape to a month and a daily one to a day', async () => {
    await filed(record({ pattern: MONTHLY }, { tip: '202501' }), '202001');
    await filed(record({ pattern: DAILY },   { tip: '20250101' }), OLD);

    reconcile(db, id, NOW);

    const tips = Object.fromEntries(
      seriesFor(db, id).map(one => [one.grain, one.tip]));

    expect(tips).toEqual({ monthly: '202606', daily: EDGE });
  });

  it('writes what it moved, so a restart reads it back', async () => {
    await filed(record({}, { tip: '20260401' }), OLD);

    reconcile(db, id, NOW);
    loadSeries(db);

    expect(seriesFor(db, id)[0]!.tip).toBe(EDGE);
  });
});

describe('where a series starts', () => {
  /**
   * **A file is evidence of a start, and the sighting that saw it writes one.**
   *
   * The old rule was that only a walk may say where a series begins, on the
   * grounds that an update sees only what it generated and would be recording
   * its own floor as a measurement. What that missed is that the floor is not a
   * wall: the keys below it are already parked in `wip`, on disk, and go on
   * being probed whatever the column says — so a start written early is lowered
   * again by anything found underneath it, and never strands the range below.
   *
   * What the old rule cost was concrete. A venue with no index has no walk, so
   * `first` could only ever be filled by a reconciliation at the end of a
   * completed pass; okx and bitget ran with files going back months under a NULL
   * start until one finished.
   */
  it('is created by a sighting, from the file that proved it', async () => {
    const row = record({}, { first: null });

    await catalogued(row, '20240310', 'p/generated');

    flushTips(db);
    expect(seriesFor(db, id)[0]!.first).toBe('20240310');
  });

  /** Backward only. An older file lowers a start; a newer one says nothing. */
  it('moves a start down to an older file and never up to a newer one', async () => {
    const row = record({}, { first: null });

    await catalogued(row, '20240310', 'p/a');
    await catalogued(row, '20230101', 'p/b');
    await catalogued(row, '20250601', 'p/c');

    flushTips(db);

    const [seen] = seriesFor(db, id);

    expect(seen!.first).toBe('20230101');
    expect(seen!.last).toBe('20250601');
  });

});

/**
 * Whether the catalog still expects files for a series.
 *
 * **One definition, because generating and being open are the same question.**
 * A series is open when we still expect files for it, and keys are generated for
 * exactly the series we still expect files for. Stated twice they would drift,
 * and silently in both directions: an "open" shape nothing asks about, or a
 * shape reported closed while requests go out for it daily.
 *
 * The cases below are the whole rule.
 */
describe('whether a series is still open', () => {
  let seq = 0;

  /** A row in memory, not a write: `open` is a pure reading of the fields. */
  const series = (over: Partial<Publishing>): Publishing => ({
    ...record({ symbol: `S${seq++}` }, { tip: '20260301' }),
    ...over,
  });

  /**
   * **Listed, on a live shape.** The venue still trades it and still writes this
   * shape, which outweighs any quiet spell — a fortnight's silence is not an end.
   */
  it('is open for a listed instrument on a live shape, however old its files', () => {
    expect(open(series({ state: 'active', retiredAt: null, last: '20200101' }))).toBe(true);
  });

  /**
   * **Nothing seen yet is open**, because there is no measurement to call it
   * finished on. Every newly listed instrument is here between its series being
   * created and the archive's first file.
   */
  it('is open where nothing has ever been seen', () => {
    expect(open(series({ state: 'delisted', retiredAt: '20240102', last: null }))).toBe(true);
  });

  /**
   * **A dead shape or a dead instrument falls back to patience**, measured from
   * the tip — how far the venue has actually been asked, which is the only thing
   * a silence can be judged against.
   */
  it('is open while a dead shape is still being written', () => {
    expect(open(series({ retiredAt: '20240102', tip: '20260301', last: '20260301' }))).toBe(true);
  });

  it('is closed once a dead shape falls outside the window', () => {
    expect(open(series({ retiredAt: '20240102', tip: '20260301', last: '20240102' }))).toBe(false);
  });

  it('is closed once a delisted instrument falls outside the window', () => {
    expect(open(series({ state: 'delisted', tip: '20260301', last: '20240102' }))).toBe(false);
  });

  /** A series with no tip has nothing to measure a silence against. */
  it('is closed where there is no tip to judge against', () => {
    expect(open(series({ state: 'delisted', tip: null, last: '20240102' }))).toBe(false);
  });
});
