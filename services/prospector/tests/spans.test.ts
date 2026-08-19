import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyFor, loadSeries, putVenue, seriesFor, venues } from '../src/catalog';
import { openCatalog } from '../src/database';
import { ceiling, yesterday } from '../src/dates';
import { okx } from '../src/adapters/okx';
import type { DatabaseSync } from 'node:sqlite';
import { addressVenues } from '../src/venues';

/**
 * The bounds okx was measured to have, and the rules that keep them honest.
 *
 * These are the only thing standing between a fresh deployment and eleven hours
 * of probing, so the checks here are about the shipped data being loadable and
 * self-consistent rather than about it being any particular set of numbers.
 */

let dir: string;
let db:  DatabaseSync;
let id:  number;

/**
 * **Built once and shared.** Every test here reads the shipped seed and none of
 * them writes to it, so a catalog per test would be thirty-four thousand series
 * inserted twenty-two times to answer twenty-two questions about the same
 * immutable rows.
 */
/**
 * **The timeout is not slack.** Opening a seeded catalog plants 114,295 series
 * across both unlisted venues, which takes seconds — past the default ten once
 * the rest of the suite is running beside it.
 */
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'spans-'));
  db  = openCatalog(join(dir, 'catalog.db'));
  id  = putVenue(db, 'okx', okx.base, okx.root);

  /** Built here, where the budget is — see the note on the timeout above. */
  loadSeries(db);
}, 60_000);

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the shipped seed', () => {
  /**
   * **Loaded by a migration, so every catalog has them.** Not by a startup hook
   * and not on the first survey: a catalog is not complete without okx's ranges
   * any more than it is without the tables holding them, and a migration is the
   * one thing that runs exactly once against every database, fresh or not.
   */
  it('are in a catalog that has only just been created', () => {
    expect(seriesFor(db, id).length).toBeGreaterThan(5_000);
  });

  it('carry a state, and are not dated today', () => {
    const [one] = seriesFor(db, id);

    expect(['active', 'delisted']).toContain(one!.state);
  });

  /**
   * **The rule the whole file exists for: a bound is shipped once it is proved,
   * and not before — so none of them is.**
   *
   * The seed this replaced carried measured bounds, and they were wrong: 2,429
   * pairs recorded as publishing nothing, at least 228 of those absences false —
   * files that existed, on days the walk sampled, served by both hosts. A wrong
   * bound outlives everyone who remembers guessing it, because generation never
   * looks below a start and never past an end.
   *
   * So the seed states no bound at all. It says which series exist and where to
   * begin asking; where each one starts and stops is the probe's to establish.
   */
  it('give every series somewhere to start', () => {
    expect(seriesFor(db, id)
      .filter(one => one.tip === null && one.first === null)).toEqual([]);
  });

  /**
   * **Every dataset okx publishes per instrument**, and only those.
   *
   * Borrowing rates are keyed by currency rather than by instrument and no
   * endpoint enumerates okx's currencies, so nothing per-symbol is bounded there
   * and its venue-wide bucket carries the same data — derived at generation time
   * rather than stored. A bucket never appears here for the same reason: it is
   * the dataset, not an instrument in it.
   */
  it('hold every dataset okx publishes, and nothing that is not one', () => {
    const datasets = new Set(seriesFor(db, id).map(one => one.dataset));

    expect(datasets).toEqual(new Set([
      'trades', 'klines', 'funding', 'books', 'borrowing',
    ]));

    /**
     * **A venue-wide file is not an instrument named `allspot`.** It is a series
     * with no symbol, and its name belongs in its pattern rather than in the
     * column that says what the venue lists.
     */
    expect(seriesFor(db, id).some(one => one.symbol.startsWith('all'))).toBe(false);
  });

  /**
   * **A tip is a claim that everything at or below it is settled**, so it may
   * never sit above where the archive could have started: too low costs probes,
   * too high loses files silently and permanently, since a tip only moves
   * forward. The seed's floors are deliberately a month or more below the
   * earliest file each dataset is thought to hold.
   *
   * **Measured against its own grain**, because the two bars are not the same
   * string. A monthly tip is `yyyymm` and a daily one `yyyymmdd`, so a daily tip
   * compared to the monthly ceiling fails on length alone — `20260804` sorts
   * above `202608` while naming a day already a month in the past. That is not
   * the seed being wrong; it is the question being asked in the wrong grain.
   */
  it('start asking from below anything the venue could have published', () => {
    const above = seriesFor(db, id)
      .filter(one => one.tip! >= (one.grain === 'monthly' ? ceiling() : yesterday()));

    expect(above).toEqual([]);
  });

  /**
   * `@` means one thing only: a series carrying every instrument of its market at
   * once. It still has a market and a dataset — what it does not have is a name
   * the venue lists, and giving that case a name of its own is what stops every
   * reader having to test for an absence.
   */
  it('use the bucket symbol only where there is no symbol axis', () => {
    const bare = seriesFor(db, id).filter(one => one.symbol === '@');

    expect(bare.length).toBeGreaterThan(0);
    expect(bare.every(one => one.market !== '' && one.dataset !== '')).toBe(true);

    // And every one of them is a daily file: the monthly form answers 404.
    expect(bare.every(one => one.grain === 'daily')).toBe(true);
  });

  /**
   * Opening again must not double them: a migration runs once, by version.
   *
   * On its own catalog, since it closes and reopens the handle — the shared one
   * every other test here reads would not survive that.
   */
  it('are not loaded twice when the catalog is reopened', () => {
    const own  = mkdtempSync(join(tmpdir(), 'reopen-'));
    const path = join(own, 'catalog.db');

    try {
      let one    = openCatalog(path);
      const mine = putVenue(one, 'okx', okx.base, okx.root);
      const before = seriesFor(one, mine).length;

      one.close();
      one = openCatalog(path);

      expect(seriesFor(one, mine)).toHaveLength(before);

      one.close();
    } finally {
      rmSync(own, { recursive: true, force: true });
    }

  /** Its own seeded catalog, twice over, is the one slow test in this file. */
  }, 30_000);
});

describe('the venue-wide files', () => {
  /**
   * **A series with no symbol is an ordinary series.** okx is not alone in
   * publishing one file carrying every instrument of a market — BitMEX did the
   * same with its quotes and trades — so this is a shape to hold, not a case to
   * branch on. It gets a row, a pattern with nothing to substitute but a date,
   * and somewhere to start, exactly like everything else.
   */
  it('are rows in the table like any other series', () => {
    const buckets = seriesFor(db, id).filter(one => one.symbol === '@');

    expect(buckets.length).toBeGreaterThan(0);

    for (const one of buckets) {
      expect(one.pattern).not.toContain('{SYMBOL}');
      expect(one.grain).toBe('daily');
      expect(one.tip ?? one.first).not.toBeNull();
    }
  });

  /**
   * Borrowing rates are the one dataset with no per-instrument series at all:
   * okx keys them by currency and enumerates no currencies, so the venue-wide
   * file is the whole of it.
   */
  it('are the only form a dataset with no symbol axis takes', () => {
    const margin = seriesFor(db, id).filter(one => one.dataset === 'borrowing');

    expect(margin.length).toBeGreaterThan(0);
    expect(margin.every(one => one.symbol === '@')).toBe(true);
  });
});

/**
 * Give the adapters their addresses, as startup does.
 *
 * **Where a venue is lives in the `venue` table**, written by a migration, so an
 * adapter carries no address until it is handed one. A test that uses a real
 * venue needs that step; one that invents its own venue does not.
 */
const address = () => {
  const here = mkdtempSync(join(tmpdir(), 'addresses-'));
  const db   = openCatalog(join(here, 'catalog.db'));

  addressVenues(venues(db));

  db.close();
  rmSync(here, { recursive: true, force: true });
};

address();

/**
 * The archive's spelling, recorded rather than reapplied.
 *
 * **The seed runs before the column exists**, since migrations are append-only
 * and the chain that ships okx's ranges predates the one that adds
 * `url_symbol`. So the migration rebuilds it — and if it did not, every futures
 * and option series would generate the plain name, which at okx is a real file
 * of a different market.
 */
/**
 * **The chain is part of the shape, not part of the instrument.**
 *
 * Okx's flat namespace puts a spot pair and a futures family under names that
 * differ by a suffix, and every series of a given pattern takes the same one —
 * measured across the whole catalog: 986 `-futureschain` under eight patterns,
 * 48 `-optionchain` under eight more, and not one pattern spelling two of its
 * symbols differently. So it lives in the template, and generating a key is
 * substitution of the venue's own name.
 */
describe('how the seeded series spell their instruments', () => {
  it('writes the chain into the pattern and records the venue own name', () => {
    const rows = seriesFor(db, id);

    const chain = rows.find(one => one.market === 'future' && one.symbol !== '@');
    const spot  = rows.find(one => one.market === 'spot' && one.symbol !== '@');

    expect(chain!.pattern).toContain('{SYMBOL}-futureschain');
    expect(chain!.symbol).not.toContain('-futureschain');

    expect(spot!.pattern).toContain('{SYMBOL}-');
    expect(spot!.pattern).not.toContain('chain');
  });

  /**
   * **NULL means the archive spells it exactly as the venue does**, which is
   * every series of every venue today. The column is for a transformation a
   * pattern cannot express because it happens inside the name.
   */
  it('records no spelling at all, because none of them needs one', () => {
    expect(seriesFor(db, id).filter(one => one.urlSymbol !== null)).toEqual([]);
  });

  it('builds a futures key with the chain in it', () => {
    const chain = seriesFor(db, id)
      .find(one => one.market === 'future' && one.symbol !== '@' && one.grain === 'daily')!;

    expect(keyFor(chain, '20260715')).toContain(`${chain.symbol}-futureschain-`);
  });

  /** A bucket has no instrument to substitute; its name is literal in the pattern. */
  it('leaves a bucket with nothing to substitute', () => {
    for (const bucket of seriesFor(db, id).filter(one => one.symbol === '@'))
      expect(bucket.pattern).not.toContain('{SYMBOL}');
  });
});
