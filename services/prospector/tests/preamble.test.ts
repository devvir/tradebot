import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  keyFor, open, putFiles, putVenue, recordSeries, retirePattern, seriesFor, updateSeries,
} from '../src/catalog';
import { openCatalog } from '../src/database';
import { preamble } from '../src/preamble';
import { fetchHead } from '../src/http';
import { s3 } from '../src/scanners/s3';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter, Found, Instrument } from '../src/types';

vi.mock('../src/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/http')>()),
  fetchHead: vi.fn(),
}));

/**
 * Asking a venue what it lists, before an update generates anything.
 *
 * **Probing can only ask about series that already exist**, so this is the only
 * way an update ever hears about a symbol listed since the last full pass.
 */
const TRADES = 'x/trades/{YYYY}{MM}{DD}/{SYMBOL}.zip';

/** A shape with a slot only the instrument can answer — bitget's margin token. */
const TOKEN  = 'x/trades/{TRANSFORM:marginToken:UMCBL}/{YYYY}{MM}{DD}/{SYMBOL}.zip';
const BOOKS  = 'x/books/{YYYY}{MM}{DD}/{SYMBOL}.zip';

/** One market, two archives — a venue shaped like binance's futures. */
const UM = 'futures/um/trades/{YYYY}{MM}{DD}/{SYMBOL}.zip';
const CM = 'futures/cm/trades/{YYYY}{MM}{DD}/{SYMBOL}.zip';

const NOW = new Date('2026-08-01T00:00:00Z');

let dir: string;
let db:  DatabaseSync;
let id:  number;
let lists: Instrument[];

const venue = (): Adapter => ({
  name:        'demo',
  scanner:     s3,
  list:        'https://demo.example',
  base:        'https://demo.example',
  root:        '',
  dateOf:      (path) => /(\d{8})/.exec(path)?.[1] ?? null,
  instruments: async () => lists,
});

/** The same venue, but one whose patterns declare which archive they serve. */
const split = (): Adapter => ({
  ...venue(),
  categoryOf: (pattern) => /futures\/(um|cm)\//.exec(pattern)?.[1] ?? null,
});

const found = (over: Partial<Found> = {}): Found =>
  ({ market: 'spot', dataset: 'trades', symbol: 'BTC-USDT', pattern: TRADES, ...over });

const at = (market: string, symbol: string, live = true): Instrument => ({ market, symbol, live });

/**
 * The two contracts the walk already found, listed back.
 *
 * **Included in every listing below** because a preamble refuses one that covers
 * less than half of what the catalog holds — a near-clean split is the adapter
 * spelling instruments differently, not a venue that relisted itself overnight.
 */
const known: Instrument[] = [
  { ...at('perp', 'BTC-USDT'), category: 'um' },
  { ...at('perp', 'BTC-USD'),  category: 'cm' },
];

const answers = (status: number) => ({
  status,
  headers: new Headers(status === 200 ? { 'content-length': '9', etag: '"e"' } : {}),
});

beforeEach(() => {
  dir   = mkdtempSync(join(tmpdir(), 'preamble-'));
  db    = openCatalog(join(dir, 'catalog.db'), { seedData: false });
  id    = putVenue(db, 'demo', 'https://demo.example', '');
  lists = [];

  vi.mocked(fetchHead).mockResolvedValue(answers(404) as never);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.mocked(fetchHead).mockReset();
});

/** What a walk left behind: a series per shape, with a tip it earned. */
const walked = (symbol: string, over: Partial<Found> = {}) =>
  recordSeries(db, id, found({ symbol, ...over }), { tip: '20260725', first: '20240101' });

describe('what a preamble adds', () => {
  it('creates a series per active shape of the instrument market', async () => {
    walked('BTC-USDT');
    walked('BTC-USDT', { dataset: 'books', pattern: BOOKS });

    lists = [at('spot', 'BTC-USDT'), at('spot', 'NEW-USDT')];

    const out = await preamble(db, venue(), id, NOW);

    expect(out).toMatchObject({ listed: 2, created: 2, revived: 0, delisted: 0, refused: false });
    expect(seriesFor(db, id, { symbol: 'NEW-USDT' }).map(one => one.dataset).sort())
      .toEqual(['books', 'trades']);
  });

  /**
   * **One market, two keyspaces.** Binance files perpetual swaps under
   * `futures/um` and `futures/cm` — two products on two endpoints — and both are
   * `perp` here, because both are perpetual swaps. That collapse is right for
   * answering questions and wrong for creating series: a contract is domiciled
   * in one of the two and can never have a key in the other.
   *
   * Left unfiltered, every newly listed perp got a series under both trees, half
   * of them describing keys that market has never held and nothing ever retires.
   */
  it('creates series only in the keyspace the instrument was listed under', async () => {
    walked('BTC-USDT', { market: 'perp', pattern: UM });
    walked('BTC-USD',  { market: 'perp', pattern: CM });

    lists = [...known, { ...at('perp', 'NEW-USDT'), category: 'um' }];

    const out = await preamble(db, split(), id, NOW);

    expect(out.created).toBe(1);
    expect(seriesFor(db, id, { symbol: 'NEW-USDT' }).map(one => one.pattern)).toEqual([UM]);
  });

  /**
   * **A venue-wide file is the dataset, not an instrument in it.**
   *
   * A pattern with no `{SYMBOL}` slot resolves to one key per date whoever asks,
   * so a series on it under an instrument's name is a second claim on the
   * bucket's own keys rather than that instrument's history. `file` is unique on
   * `(venue_id, path)`, so whichever series settles a date keeps it — and the
   * dataset ends up scattered across whichever names happened to be listed.
   *
   * Measured on okx: the `@` series for `allspot-trades` held 11 files while
   * 1,797 of its own objects sat under `GRVT-USDC`, an instrument listed days
   * before, which then appeared to have five years of history it never had.
   */
  it('gives an instrument no series on a venue-wide file', async () => {
    walked('BTC-USDT');
    walked('@', { dataset: 'klines', pattern: 'x/klines/{YYYY}{MM}{DD}/allspot.zip' });

    lists = [at('spot', 'BTC-USDT'), at('spot', 'NEW-USDT')];

    const out = await preamble(db, venue(), id, NOW);

    /** The trades shape, and nothing on the bucket. */
    expect(out.created).toBe(1);
    expect(seriesFor(db, id, { symbol: 'NEW-USDT' }).map(one => one.dataset)).toEqual(['trades']);

    /** And the bucket keeps the one series that belongs on it. */
    expect(seriesFor(db, id, { dataset: 'klines' }).map(one => one.symbol)).toEqual(['@']);
  });

  /**
   * **A bucket's absence from a listing is guaranteed, not informative.** It is
   * not an instrument, so no listing can ever name it — and reading that absence
   * as a delisting retires the dataset itself on every pass. Whether a
   * venue-wide file has stopped is a question for the files, which `last` and
   * `open` already answer.
   */
  it('never delists a venue-wide file', async () => {
    walked('BTC-USDT');
    walked('@', { dataset: 'klines', pattern: 'x/klines/{YYYY}{MM}{DD}/allspot.zip' });

    /** A listing that names the instrument and, as always, not the bucket. */
    lists = [at('spot', 'BTC-USDT')];

    const out = await preamble(db, venue(), id, NOW);

    expect(out.delisted).toBe(0);
    expect(seriesFor(db, id, { dataset: 'klines' }).map(one => one.state)).toEqual(['active']);
  });

  /**
   * **Both sides have to say something, or nothing is refused.** A venue with
   * one archive per market names no category, and every pattern is still
   * offered — so this rule cannot cost a venue series by being silent.
   */
  it('offers every pattern where the adapter names no keyspace', async () => {
    walked('BTC-USDT', { market: 'perp', pattern: UM });
    walked('BTC-USD',  { market: 'perp', pattern: CM });

    lists = [...known, { ...at('perp', 'NEW-USDT'), category: 'um' }];

    const out = await preamble(db, venue(), id, NOW);

    expect(out.created).toBe(2);
  });

  it('offers every pattern where the listing names no category', async () => {
    walked('BTC-USDT', { market: 'perp', pattern: UM });
    walked('BTC-USD',  { market: 'perp', pattern: CM });

    lists = [...known, at('perp', 'NEW-USDT')];

    const out = await preamble(db, split(), id, NOW);

    expect(out.created).toBe(2);
  });

  /**
   * **A revived series is not re-walked.** A backfill goes *down* from the floor
   * to find where a series begins, which is settled for anything with a `first`
   * on record — the archive below it has been read. Walking it again re-probes
   * years to re-find catalogued files, which is what gate's tradfi market did
   * twice a day while it was being wrongly delisted and revived.
   */
  it('does not backfill a relisted series whose start is already known', async () => {
    const gone = walked('OLD-USDT');

    updateSeries(db, { ...gone, state: 'delisted' });
    walked('BTC-USDT');

    lists = [at('spot', 'OLD-USDT'), at('spot', 'BTC-USDT')];

    const out = await preamble(db, venue(), id, NOW);

    expect(out.revived).toBe(1);
    expect(fetchHead).not.toHaveBeenCalled();
  });

  /**
   * **But one that never published is**, which is the case the walk exists for:
   * a symbol relisted after a gap has history below the floor that nothing else
   * will ever reach.
   */
  it('backfills a relisted series that has never published', async () => {
    const gone = walked('NEVER-USDT');

    updateSeries(db, { ...gone, state: 'delisted', first: null });
    walked('BTC-USDT');

    lists = [at('spot', 'NEVER-USDT'), at('spot', 'BTC-USDT')];

    await preamble(db, venue(), id, NOW);

    expect(fetchHead).toHaveBeenCalled();
  });

  /**
   * **A tip is a claim, and a new series has not earned one** — so it is probed
   * for, from the floor down, rather than asserted. One request where the
   * instrument is as new as it looks.
   */
  it('earns a tip for what it creates rather than asserting one', async () => {
    walked('BTC-USDT');
    lists = [at('spot', 'BTC-USDT'), at('spot', 'NEW-USDT')];

    await preamble(db, venue(), id, NOW);

    // The last day that had closed OVERDUE_DAYS before the newest tip the venue
    // was covered to: 20260725 - 15d is the 10th, whose last closed day is the 9th.
    expect(seriesFor(db, id, { symbol: 'NEW-USDT' })[0]!.tip).toBe('20260709');
    expect(fetchHead).toHaveBeenCalledTimes(1);
  });

  it('recovers history below the floor where the venue has some', async () => {
    walked('BTC-USDT');
    lists = [at('spot', 'BTC-USDT'), at('spot', 'NEW-USDT')];

    vi.mocked(fetchHead).mockImplementation(async (_adapter, url: string) =>
      answers(/20260707|20260708|20260709/.test(url) ? 200 : 404) as never);

    const out = await preamble(db, venue(), id, NOW);

    expect(out.found).toBe(3);
    expect(db.prepare('SELECT COUNT(*) AS n FROM file').get()).toMatchObject({ n: 3 });
  });

  /** The archive under a symbol that comes back is the same archive. */
  it('revives a relisted instrument instead of duplicating it', async () => {
    const gone = walked('OLD-USDT');

    updateSeries(db, { ...gone, state: 'delisted', last: '20250101' });

    walked('BTC-USDT');

    lists = [at('spot', 'OLD-USDT'), at('spot', 'BTC-USDT')];

    const out = await preamble(db, venue(), id, NOW);

    expect(out).toMatchObject({ created: 0, revived: 1 });
    expect(seriesFor(db, id, { symbol: 'OLD-USDT' })).toHaveLength(1);

    const back = seriesFor(db, id, { symbol: 'OLD-USDT' })[0]!;

    /**
     * **Reopened without erasing what was measured.** The newest file ever seen
     * does not become untrue because the venue relisted the instrument — and it
     * does not need to be thrown away to reopen the series, because `open` reads
     * `state` first.
     */
    expect(back.state).toBe('active');
    expect(back.last).toBe('20250101');
    expect(open(back)).toBe(true);
  });

  /**
   * **A tip is written when the row is, not when the backfill returns.** A
   * series created without one is invisible to generation and to every later
   * preamble — it reads as already discovered — so a pass killed between the two
   * would strand it for good.
   */
  it('gives a created series its tip before probing anything', async () => {
    walked('BTC-USDT');
    lists = [at('spot', 'BTC-USDT'), at('spot', 'NEW-USDT')];

    vi.mocked(fetchHead).mockImplementation(async () => {
      // Whatever the row holds at this moment is what a kill would leave behind.
      expect(seriesFor(db, id, { symbol: 'NEW-USDT' })[0]!.tip).toBe('20260709');

      return answers(404) as never;
    });

    await preamble(db, venue(), id, NOW);
  });

  /**
   * A relisted series keeps years of dead tip otherwise, and its first update
   * would generate every day of it.
   */
  it('lifts a revived series tip to the floor', async () => {
    const gone = walked('OLD-USDT');

    updateSeries(db, { ...gone, state: 'delisted', last: '20250101', tip: '20250101' });
    walked('BTC-USDT');

    lists = [at('spot', 'OLD-USDT'), at('spot', 'BTC-USDT')];

    await preamble(db, venue(), id, NOW);

    expect(seriesFor(db, id, { symbol: 'OLD-USDT' })[0]!.tip).toBe('20260709');
  });

  /**
   * **A shape the venue stopped writing to does not come back with the symbol.**
   * okx's plain order-book tree has a last file with a date on it; relisting an
   * instrument says nothing about a tree that is finished. The pattern's state
   * decides, not the series'.
   */
  it('does not resurrect a series whose pattern was retired', async () => {
    const gone = walked('OLD-USDT');
    const book = walked('OLD-USDT', { dataset: 'books', pattern: BOOKS });

    updateSeries(db, { ...gone, state: 'delisted', last: '20250101' });
    updateSeries(db, { ...book, state: 'delisted', last: '20250101' });
    retirePattern(db, book.patternId, '20240102');

    walked('BTC-USDT');
    lists = [at('spot', 'OLD-USDT'), at('spot', 'BTC-USDT')];

    const out = await preamble(db, venue(), id, NOW);

    const back = seriesFor(db, id, { symbol: 'OLD-USDT' });
    const byShape = Object.fromEntries(back.map(one => [one.dataset, one.state]));

    expect(out.revived).toBe(1);
    expect(byShape).toEqual({ trades: 'active', books: 'delisted' });
  });

  /**
   * **And a row on a retired shape is not coverage.** A symbol whose only
   * surviving series sits under a shape the venue abandoned still needs series
   * on the ones it writes today — reading that row as "already have it" is how
   * it would silently never get them.
   */
  it('creates current shapes for a symbol only held under a retired one', async () => {
    const book = walked('ONLY-BOOKS', { dataset: 'books', pattern: BOOKS });

    retirePattern(db, book.patternId, '20240102');
    walked('BTC-USDT');

    lists = [at('spot', 'ONLY-BOOKS'), at('spot', 'BTC-USDT')];

    await preamble(db, venue(), id, NOW);

    const shapes = seriesFor(db, id, { symbol: 'ONLY-BOOKS' })
      .filter(one => one.retiredAt === null)
      .map(one => one.dataset);

    expect(shapes).toEqual(['trades']);
  });
});

describe('what a preamble retires', () => {
  it('delists a series the venue no longer lists', async () => {
    walked('BTC-USDT');
    walked('GONE-USDT');

    lists = [at('spot', 'BTC-USDT')];

    const out = await preamble(db, venue(), id, NOW);

    expect(out.delisted).toBe(1);
    expect(seriesFor(db, id, { symbol: 'GONE-USDT' })[0]!.state).toBe('delisted');
    expect(seriesFor(db, id, { symbol: 'BTC-USDT' })[0]!.state).toBe('active');
  });

  /** Listed and not live is the venue saying so, which beats absence. */
  it('delists an instrument the venue lists as no longer trading', async () => {
    walked('OFF-USDT');
    lists = [at('spot', 'OFF-USDT', false)];

    expect((await preamble(db, venue(), id, NOW)).delisted).toBe(1);
  });

  /**
   * **Only markets the venue answered about.** A list covering spot and silent
   * on options is not a statement that the options are gone — and most venues
   * split their API across endpoints, so silence is the normal case.
   */
  it('leaves a market the listing said nothing about alone', async () => {
    walked('BTC-USDT');
    walked('ETH-PERP', { market: 'perp' });

    lists = [at('spot', 'BTC-USDT')];

    expect((await preamble(db, venue(), id, NOW)).delisted).toBe(0);
    expect(seriesFor(db, id, { symbol: 'ETH-PERP' })[0]!.state).toBe('active');
  });

  /**
   * **It records what the venue said, and nothing about endings.**
   *
   * Deciding a series was finished used to happen here, by writing `last` — set
   * from `MAX(date)` for a delisted instrument gone quiet, cleared for anything
   * still listed. That made the field a verdict and destroyed the measurement in
   * it. Whether a series is finished is now read from that measurement by
   * `open`, which is what generation asks too.
   */
  it('leaves the measured end alone when it delists an instrument', async () => {
    const row = walked('GONE-USDT');

    updateSeries(db, { ...row, last: '20250101' });
    walked('BTC-USDT');
    lists = [at('spot', 'BTC-USDT')];

    const out = await preamble(db, venue(), id, NOW);

    expect(out.delisted).toBe(1);

    const gone = seriesFor(db, id, { symbol: 'GONE-USDT' })[0]!;

    expect(gone.state).toBe('delisted');
    expect(gone.last).toBe('20250101');

    /** Long past the patience window, so nothing expects more of it. */
    expect(open(gone)).toBe(false);
  });

  /** A delisted instrument still writing files keeps being asked about. */
  it('leaves a delisted instrument that is still publishing open', async () => {
    const row = walked('QUIET-USDT');

    updateSeries(db, { ...row, last: '20260724' });
    walked('BTC-USDT');
    lists = [at('spot', 'BTC-USDT')];

    expect((await preamble(db, venue(), id, NOW)).delisted).toBe(1);

    const quiet = seriesFor(db, id, { symbol: 'QUIET-USDT' })[0]!;

    expect(quiet.last).toBe('20260724');
    expect(open(quiet)).toBe(true);
  });

  /**
   * **A listed instrument is open whatever its files did**, and it does not need
   * its measurement erased to say so. `state` is what reopens it, and `open`
   * reads that before it looks at any date.
   */
  it('keeps the end a walk recorded for an instrument still listed', async () => {
    const row = walked('BTC-USDT');

    updateSeries(db, { ...row, last: '20260725' });
    lists = [at('spot', 'BTC-USDT')];

    await preamble(db, venue(), id, NOW);

    const back = seriesFor(db, id, { symbol: 'BTC-USDT' })[0]!;

    expect(back.last).toBe('20260725');
    expect(open(back)).toBe(true);
  });

  /**
   * **A relisted instrument that had never published is reopened too.** Nothing
   * about the *archive* changed, but the venue listing the symbol again is new
   * information, and the series it had are the ones that would carry any files
   * it now writes.
   *
   * Such a row only survives to be revived if reconciliation has not run since
   * it was delisted — once it has, the row is gone and a relisting creates it
   * afresh instead. Both paths end with the instrument being asked about.
   */
  it('revives a delisted series that never published when the venue lists it again', async () => {
    const gone = walked('NEVER-USDT');

    updateSeries(db, { ...gone, state: 'delisted', first: null });
    walked('BTC-USDT');

    lists = [at('spot', 'NEVER-USDT'), at('spot', 'BTC-USDT')];

    const out = await preamble(db, venue(), id, NOW);

    expect(out).toMatchObject({ created: 0, revived: 1 });

    const back = seriesFor(db, id, { symbol: 'NEVER-USDT' });

    expect(back).toHaveLength(1);
    expect(back[0]!.state).toBe('active');
  });
});

describe('when the names do not agree', () => {
  /**
   * **The one failure that is silent and total.** An API answering `btcusdt`
   * where the archive writes `BTC-USDT` makes every instrument look new, so the
   * step would create a parallel set of series *and* delist every real one.
   */
  it('refuses rather than creating a parallel set of series', async () => {
    for (const symbol of ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'XRP-USDT']) walked(symbol);

    lists = ['btcusdt', 'ethusdt', 'solusdt', 'xrpusdt'].map(one => at('spot', one));

    const out = await preamble(db, venue(), id, NOW);

    expect(out).toMatchObject({ refused: true, created: 0, delisted: 0 });
    expect(seriesFor(db, id).every(one => one.state === 'active')).toBe(true);
    expect(seriesFor(db, id)).toHaveLength(4);
  });

  /**
   * **A venue does not relist itself overnight.** A busy week adds tens of
   * instruments to a venue holding thousands, so a healthy pass is nearly all
   * familiar names and the gate never comes near firing.
   */
  it('proceeds where most of what the venue lists is already known', async () => {
    for (const symbol of ['BTC-USDT', 'ETH-USDT', 'SOL-USDT']) walked(symbol);

    lists = [
      ...['BTC-USDT', 'ETH-USDT', 'SOL-USDT'].map(one => at('spot', one)),
      at('spot', 'NEW-USDT'),
    ];

    const out = await preamble(db, venue(), id, NOW);

    expect(out.refused).toBe(false);
    expect(out.created).toBe(1);
  });

  /**
   * **A transform is what a listing knows and nothing downstream can recover.**
   *
   * Bitget's futures trades sit under a margin token that is a property of the
   * category the contract was listed in — not of its symbol, not of its market,
   * and not of any path. Left unwritten, the pattern's own default stands, the
   * generated key is well formed, the bucket answers that it is not there, and
   * the contract reads as one that publishes nothing.
   */
  it('writes the transforms an instrument declares, before its series exist', async () => {
    walked('BTC-USDT', { pattern: TOKEN });

    lists = [
      at('spot', 'BTC-USDT'),
      { ...at('spot', 'NEW-USD'), transforms: [{
        dataset: 'trades', kind: 'marginToken', transform: 'DMCBL', from_: '19700101', to_: null,
      }] },
    ];

    await preamble(db, venue(), id, NOW);

    const [series] = seriesFor(db, id, { symbol: 'NEW-USD' });

    expect(series!.transforms).toHaveLength(1);
    expect(keyFor(series!, '20260801')).toBe('x/trades/DMCBL/20260801/NEW-USD.zip');
  });

  /** An instrument that declares nothing generates on the pattern's own default. */
  it('leaves the default standing where an instrument declares no transform', async () => {
    walked('BTC-USDT', { pattern: TOKEN });

    lists = [at('spot', 'BTC-USDT'), at('spot', 'NEW-USDT')];

    await preamble(db, venue(), id, NOW);

    const [series] = seriesFor(db, id, { symbol: 'NEW-USDT' });

    expect(series!.transforms).toBeUndefined();
    expect(keyFor(series!, '20260801')).toBe('x/trades/UMCBL/20260801/NEW-USDT.zip');
  });

  it('does nothing at all for a venue with no listing to ask for', async () => {
    walked('BTC-USDT');

    const bare = { ...venue(), instruments: undefined };

    expect(await preamble(db, bare, id, NOW)).toMatchObject({ listed: 0, refused: false });
  });
});
