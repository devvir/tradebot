import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dropLens, editLens, lensNamed, lensOptions, lensSize, lenses, problemsWith, putFiles, putLens,
  putVenue, recordSeries, resolve,
} from '../src/catalog';
import { openCatalog } from '../src/database';
import type { LensDefinition } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * A lens: what it lets through, and what it refuses to be.
 *
 * **The thing worth testing is the composition.** Every dimension but the date is
 * a set of strings matched against a column, which is hard to get wrong; the
 * ordered include/exclude over date spans is what makes "everything up to a date,
 * except books, except recent trades" either work or quietly lie.
 */

let dir: string;
let db:  DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lens-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });

  const venue = putVenue(db, 'binance', 'https://x', '');

  for (const [market, dataset, variant, grain, symbol] of [
    ['spot', 'trades', '',   'daily',   'BTCUSDT'],
    ['spot', 'trades', '',   'monthly', 'BTCUSDT'],
    ['spot', 'klines', '1m', 'daily',   'BTCUSDT'],
    ['spot', 'klines', '1h', 'daily',   'BTCUSDT'],
    ['spot', 'books',  '',   'daily',   'BTCUSDT'],
    ['perp', 'trades', '',   'daily',   'ETHUSDT'],
    ['perp', 'trades', '',   'daily',   '@'],
  ] as const)
    recordSeries(db, venue, { market, dataset, variant, symbol,
      pattern: `${market}/${dataset}${variant}/${grain}/{SYMBOL}/`
             + (grain === 'monthly' ? '{YYYY}{MM}.zip' : '{YYYY}{MM}{DD}.zip') });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const lens = (venues: LensDefinition['venues']): LensDefinition => ({ format: 1, venues });

/** How many series a definition lets through, across every venue. */
const selects = (definition: LensDefinition): number =>
  [...resolve(db, definition).values()].reduce((sum, one) => sum + one.length, 0);

describe('what a lens lets through', () => {
  it('lets nothing through where nothing is included', () => {
    expect(selects(lens({}))).toBe(0);
    expect(selects(lens({ binance: [] }))).toBe(0);
  });

  /** Evaluation starts from the empty set, so subtracting from it is a no-op. */
  it('lets nothing through where the first rule excludes', () => {
    expect(selects(lens({ binance: [{ effect: 'exclude', datasets: [{ dataset: 'books' }] }] }))).toBe(0);
  });

  it('takes a rule with no dimensions as the whole venue', () => {
    expect(selects(lens({ binance: [{ effect: 'include' }] }))).toBe(7);
  });

  it('narrows on one dimension and leaves the rest open', () => {
    expect(selects(lens({ binance: [{ effect: 'include', datasets: [{ dataset: 'trades' }] }] }))).toBe(4);
    expect(selects(lens({ binance: [{ effect: 'include', markets: ['perp'] }] }))).toBe(2);
    expect(selects(lens({ binance: [{ effect: 'include', grains: ['monthly'] }] }))).toBe(1);
  });

  /**
   * **The case a flat variants list could not say.** A variant belongs to its
   * dataset and to nothing else — `1m` is a kline length, and trades and books
   * have variants of their own — so asking for one length of kline *and* every
   * trade needs the two named as pairs. Flat lists AND together and let neither
   * through.
   */
  it('narrows one dataset to a variant while leaving another whole', () => {
    expect(selects(lens({ binance: [{ effect: 'include', datasets: [
      { dataset: 'klines', variant: '1m' },
      { dataset: 'trades' },
    ] }] }))).toBe(5);   // four trades series, and one kline length
  });

  it('takes a dataset named without a variant as every variant of it', () => {
    expect(selects(lens({ binance: [
      { effect: 'include', datasets: [{ dataset: 'klines' }] },
    ] }))).toBe(2);
  });

  it('narrows on several at once', () => {
    expect(selects(lens({ binance: [
      { effect: 'include', datasets: [{ dataset: 'klines', variant: '1m' }] },
    ] }))).toBe(1);
  });

  /** The composition, and the example the whole format was designed around. */
  it('composes include then exclude, in order', () => {
    expect(selects(lens({ binance: [
      { effect: 'include' },
      { effect: 'exclude', datasets: [{ dataset: 'books' }] },
    ] }))).toBe(6);
  });

  it('lets a later include put back what an earlier exclude took', () => {
    expect(selects(lens({ binance: [
      { effect: 'include' },
      { effect: 'exclude', datasets: [{ dataset: 'klines' }] },
      { effect: 'include', datasets: [{ dataset: 'klines', variant: '1m' }] },
    ] }))).toBe(6);
  });

  /**
   * **`@` is an ordinary instrument.** It is the venue-wide file covering every
   * instrument of a market, and naming it selects those series with no special
   * case — so buckets and a few named instruments is one rule.
   */
  it('treats the bucket as an instrument like any other', () => {
    expect(selects(lens({ binance: [{ effect: 'include', instruments: ['@'] }] }))).toBe(1);

    expect(selects(lens({ binance: [
      { effect: 'include', instruments: ['@', 'ETHUSDT'] },
    ] }))).toBe(2);
  });
});

/**
 * **A rule under `*` is about every venue**, and it runs before that venue's own.
 *
 * It is what keeps *everything up to 2020* one rule rather than one per venue —
 * and, because rules compose in order, what lets a venue then carve its own
 * exception out of it.
 */
describe('rules that are about every venue', () => {
  beforeEach(() => {
    const other = putVenue(db, 'gate', 'https://g', '');

    recordSeries(db, other, { market: 'spot', dataset: 'trades', symbol: 'BTC_USDT',
      pattern: 'spot/trades/{SYMBOL}/{YYYY}{MM}{DD}.zip' });
  });

  it('reaches venues the lens never names', () => {
    expect(selects(lens({ '*': [{ effect: 'include', datasets: [{ dataset: 'trades' }] }] })))
      .toBe(5);   // four at binance, one at gate
  });

  it('lets a venue carve its own exception out of a global rule', () => {
    expect(selects(lens({
      '*':    [{ effect: 'include' }],
      binance: [{ effect: 'exclude', datasets: [{ dataset: 'books' }] }],
    }))).toBe(7);   // eight series in all, less binance's one books series
  });

  /** Global first: a venue's own rules see what the globals left. */
  it('applies the global rules before a venue\'s own', () => {
    expect(selects(lens({
      '*':     [{ effect: 'include', datasets: [{ dataset: 'trades' }] }],
      binance: [{ effect: 'include', datasets: [{ dataset: 'books' }] }],
    }))).toBe(6);
  });

  it('is not itself a venue, and needs none named', () => {
    expect(problemsWith(db, lens({ '*': [{ effect: 'include' }] }))).toEqual([]);
  });

  /** A venue whose first rule excludes is fine where a global included first. */
  it('does not call a venue empty when the globals fill it', () => {
    expect(problemsWith(db, lens({
      '*':     [{ effect: 'include' }],
      binance: [{ effect: 'exclude', datasets: [{ dataset: 'books' }] }],
    }))).toEqual([]);
  });

  /** What a global rule may name is what any venue publishes. */
  it('accepts a dataset only one venue has', () => {
    expect(problemsWith(db, lens({ '*': [{ effect: 'include', datasets: [
      { dataset: 'books' },
    ] }] }))).toEqual([]);
  });
});

describe('the time a lens lets through', () => {
  const spansOf = (definition: LensDefinition) =>
    [...resolve(db, definition).values()].flat()[0]?.spans;

  it('is everything where no bound is given', () => {
    expect(spansOf(lens({ binance: [{ effect: 'include', datasets: [{ dataset: 'books' }] }] })))
      .toEqual([{ from: null, to: null }]);
  });

  it('carries the bounds a rule states', () => {
    expect(spansOf(lens({ binance: [
      { effect: 'include', datasets: [{ dataset: 'books' }], from: '202401', to: '202412' },
    ] }))).toEqual([{ from: '202401', to: '202412' }]);
  });

  /**
   * **The case a single range could not express.** Excluding a year from the
   * middle of a decade has to leave two spans, or the lens hands back a year
   * nobody asked for.
   */
  it('splits a span where a later rule carves a hole in it', () => {
    expect(spansOf(lens({ binance: [
      { effect: 'include', datasets: [{ dataset: 'books' }], from: '201901', to: '202112' },
      { effect: 'exclude', datasets: [{ dataset: 'books' }], from: '202001', to: '202012' },
    ] }))).toEqual([
      { from: '201901', to: '201912' },
      { from: '202101', to: '202112' },
    ]);
  });

  /** A series every rule excluded is absent, not present with no time. */
  it('drops a series whose whole span was taken away', () => {
    expect(selects(lens({ binance: [
      { effect: 'include', datasets: [{ dataset: 'books' }], from: '201901', to: '201912' },
      { effect: 'exclude', datasets: [{ dataset: 'books' }] },
    ] }))).toBe(0);
  });
});

describe('storing one', () => {
  it('makes one, lists it, and gives it back by name', () => {
    const made = putLens(db, 'cold-store', 'Cold store', 'everything old');

    expect(made).toMatchObject({ slug: 'cold-store', name: 'Cold store', note: 'everything old' });
    expect(lenses(db)).toHaveLength(1);
    expect(lensNamed(db, 'cold-store')?.definition).toEqual({ format: 1, venues: {} });
  });

  it('refuses a name already taken', () => {
    putLens(db, 'cold-store', '', '');

    expect(putLens(db, 'cold-store', '', '')).toBeNull();
  });

  it('replaces the definition whole', () => {
    putLens(db, 'cold-store', '', '');

    const to = lens({ binance: [{ effect: 'include', datasets: [{ dataset: 'trades' }] }] });

    expect(editLens(db, 'cold-store', { definition: to })?.definition).toEqual(to);
  });

  it('re-addresses one, and the old slug stops answering', () => {
    putLens(db, 'cold-store', '', '');
    editLens(db, 'cold-store', { slug: 'archive' });

    expect(lensNamed(db, 'cold-store')).toBeNull();
    expect(lensNamed(db, 'archive')).not.toBeNull();
  });

  it('takes one away, and says whether there was one', () => {
    putLens(db, 'cold-store', '', '');

    expect(dropLens(db, 'cold-store')).toBe(true);
    expect(dropLens(db, 'cold-store')).toBe(false);
  });

  /** A lens is an allow-list, so a document nobody can read lets nothing through. */
  it('reads an unparseable definition as letting nothing through', () => {
    putLens(db, 'cold-store', '', '');
    db.prepare(`UPDATE lens SET definition = 'not json'`).run();

    expect(lensNamed(db, 'cold-store')?.definition).toEqual({ format: 1, venues: {} });
  });
});

describe('why a lens is refused', () => {
  it('accepts one that names what the venue publishes', () => {
    expect(problemsWith(db, lens({ binance: [{ effect: 'include', datasets: [{ dataset: 'trades' }] }] })))
      .toEqual([]);
  });

  it('names a venue that does not exist', () => {
    expect(problemsWith(db, lens({ nowhere: [{ effect: 'include' }] })))
      .toMatchObject([{ venue: 'nowhere', rule: -1 }]);
  });

  /** The silent fault: a dataset the venue does not have looks like a quiet venue. */
  it('names a dataset the venue does not publish, and where', () => {
    expect(problemsWith(db, lens({ binance: [
      { effect: 'include', datasets: [{ dataset: 'trades' }] },
      { effect: 'exclude', datasets: [{ dataset: 'funding' }] },
    ] }))).toMatchObject([{ venue: 'binance', rule: 1, field: 'datasets' }]);
  });

  /** A variant is weighed against the dataset it was named with, never loose. */
  it('names a variant that dataset does not publish', () => {
    expect(problemsWith(db, lens({ binance: [
      { effect: 'include', datasets: [{ dataset: 'trades', variant: '1m' }] },
    ] }))).toMatchObject([{ field: 'datasets' }]);

    expect(problemsWith(db, lens({ binance: [
      { effect: 'include', datasets: [{ dataset: 'klines', variant: '1m' }] },
    ] }))).toEqual([]);
  });

  it('warns that a list opening with exclude sees nothing', () => {
    expect(problemsWith(db, lens({ binance: [{ effect: 'exclude', datasets: [{ dataset: 'books' }] }] })))
      .toMatchObject([{ rule: 0 }]);
  });

  it('separates an empty list from an absent one', () => {
    expect(problemsWith(db, lens({ binance: [{ effect: 'include', datasets: [] as never[] }] })))
      .toMatchObject([{ field: 'datasets' }]);

    expect(problemsWith(db, lens({ binance: [{ effect: 'include' }] }))).toEqual([]);
  });

  /** A day is a false precision here — a monthly file cannot be halved by one. */
  it('refuses a bound that is not a month', () => {
    expect(problemsWith(db, lens({ binance: [
      { effect: 'include', from: '20200601' },
    ] }))).toMatchObject([{ field: 'from' }]);

    expect(problemsWith(db, lens({ binance: [
      { effect: 'include', from: '202013' },
    ] }))).toMatchObject([{ field: 'from' }]);

    expect(problemsWith(db, lens({ binance: [
      { effect: 'include', from: '202006', to: '202012' },
    ] }))).toEqual([]);
  });

  it('refuses a range that ends before it starts', () => {
    expect(problemsWith(db, lens({ binance: [
      { effect: 'include', from: '202101', to: '202012' },
    ] }))).toMatchObject([{ field: 'to' }]);
  });
});

describe('what a venue offers a rule', () => {
  it('lists every combination that has a series, with how many', () => {
    const offered = lensOptions(db, 'binance');

    expect(offered).toHaveLength(6);
    expect(offered.find(one => one.dataset === 'trades' && one.market === 'perp')?.series).toBe(2);
  });
});

describe('what it would cost', () => {
  it('counts a small selection exactly', async () => {
    const one = resolve(db, lens({ binance: [{ effect: 'include', datasets: [{ dataset: 'books' }] }] }));
    const id  = [...one.values()].flat()[0]!.seriesId;

    await putFiles(db, [
      { venueId: 1, path: 'a', date: '202401', size: 10, etag: 'e', modified: null,
        existence: 'confirmed', seenAt: 'T1', seriesId: id },
      { venueId: 1, path: 'b', date: '202501', size: 20, etag: 'e', modified: null,
        existence: 'confirmed', seenAt: 'T1', seriesId: id },
    ]);

    expect(lensSize(db, lens({ binance: [{ effect: 'include', datasets: [{ dataset: 'books' }] }] })))
      .toEqual({ series: 1, files: 2, bytes: 30, exact: true });
  });

  /** The date bound is part of the price, not applied afterwards. */
  it('leaves out files the lens does not let through', async () => {
    const one = resolve(db, lens({ binance: [{ effect: 'include', datasets: [{ dataset: 'books' }] }] }));
    const id  = [...one.values()].flat()[0]!.seriesId;

    await putFiles(db, [
      { venueId: 1, path: 'a', date: '202401', size: 10, etag: 'e', modified: null,
        existence: 'confirmed', seenAt: 'T1', seriesId: id },
      { venueId: 1, path: 'b', date: '202501', size: 20, etag: 'e', modified: null,
        existence: 'confirmed', seenAt: 'T1', seriesId: id },
    ]);

    expect(lensSize(db, lens({ binance: [
      { effect: 'include', datasets: [{ dataset: 'books' }], to: '202412' },
    ] }))).toMatchObject({ files: 1, bytes: 10 });
  });

  /**
   * **The bound has to survive the cheap road.** A lens that narrows nothing but
   * the dates is answered from the `month` rollup rather than from `file`, and
   * that is exactly the path where a dropped bound returns the whole archive
   * while looking like a considered number.
   */
  it('honours a date bound on the rollup path', async () => {
    const one = resolve(db, lens({ binance: [{ effect: 'include' }] }));
    const id  = [...one.values()].flat()[0]!.seriesId;

    await putFiles(db, [
      { venueId: 1, path: 'a', date: '20230101', size: 10, etag: 'e', modified: null,
        existence: 'confirmed', seenAt: 'T1', seriesId: id },
      { venueId: 1, path: 'b', date: '20240101', size: 90, etag: 'e', modified: null,
        existence: 'confirmed', seenAt: 'T1', seriesId: id },
    ]);

    expect(lensSize(db, lens({ binance: [{ effect: 'include' }] })).bytes).toBe(100);
    expect(lensSize(db, lens({ binance: [{ effect: 'include', to: '202312' }] })).bytes).toBe(10);
  });

  /** And the same where the bound is global rather than the venue's own. */
  it('honours a date bound that came from the global rules', async () => {
    const one = resolve(db, lens({ binance: [{ effect: 'include' }] }));
    const id  = [...one.values()].flat()[0]!.seriesId;

    await putFiles(db, [
      { venueId: 1, path: 'a', date: '20230101', size: 10, etag: 'e', modified: null,
        existence: 'confirmed', seenAt: 'T1', seriesId: id },
      { venueId: 1, path: 'b', date: '20240101', size: 90, etag: 'e', modified: null,
        existence: 'confirmed', seenAt: 'T1', seriesId: id },
    ]);

    expect(lensSize(db, lens({ '*': [{ effect: 'include', to: '202312' }] })).bytes).toBe(10);
  });

  it('is nothing where the lens selects nothing', () => {
    expect(lensSize(db, lens({}))).toEqual({ series: 0, files: 0, bytes: 0, exact: true });
  });
});
