import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSeries, seriesFor, venueIdOf } from '../src/catalog';
import { openCatalog } from '../src/database';
import { updatePage, updateScopes } from '../src/update';
import { okx } from '../src/adapters/okx';
import { seriesSeededAt } from '../src/database/migrations/seeds/seed';
import type { DatabaseSync } from 'node:sqlite';

/**
 * What a shipped seed is for, and what it must not do.
 *
 * A seed says **which series exist and where to start asking**, and carries a
 * bound only where something measured one — never a guess. Generation never
 * looks below a start or past an end, so a wrong bound is not merely wrong, it
 * is unreachable.
 *
 * The venues here are the two nothing can discover — no listing at any layer —
 * which is the only reason a seed exists at all.
 */

let dir: string;
let db:  DatabaseSync;

/** How many rows one of a venue's seed files holds, header excluded. */
const seeded = (venue: string, table: string): number =>
  readFileSync(join(__dirname, '../src/database/migrations/seeds', venue, `${table}.csv`), 'utf8')
    .trim().split('\n').length - 1;

/**
 * **Built once and shared.** These all read the shipped seed and none of them
 * writes to it, so a catalog per test would plant 114,295 series over again to
 * answer one more question about the same rows.
 */
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'seed-'));
  db  = openCatalog(join(dir, 'catalog.db'));

  /**
   * **Built here, where the budget is.** The registry loads lazily on first
   * access, so without this the first test to touch it pays for 114,295 series
   * and trips the per-test timeout under load.
   */
  loadSeries(db);
}, 60_000);

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a seeded venue', () => {
  /**
   * **Every row of both files, and its pattern resolved.** Counted against the
   * files rather than against a number written here: the seeds are rewritten as
   * their venues are measured, so a literal would be asserting last week's
   * inventory. What must hold is that nothing is dropped on the way in and every
   * `pattern_id` finds its shape.
   */
  it('lands every row both files hold', () => {
    for (const venue of ['okx', 'bitget']) {
      const rows = seriesFor(db, venueIdOf(db, venue));

      expect(rows).toHaveLength(seeded(venue, 'series'));
      expect(new Set(rows.map(one => one.patternId)).size).toBe(seeded(venue, 'pattern'));
    }
  });

  /**
   * **How many bounds a seed carries is not a rule; what they may say is.**
   *
   * The seeds for these two venues are rewritten as their passes establish more,
   * so any count asserted here is a number that changes next week. These are the
   * invariants that hold at every stage of that:
   *
   * - every series has somewhere to start: a tip, a `first`, or both
   * - a `last` may stand alone, because seeing a file proves an end and says
   *   nothing about a start
   * - a `first` may not, because whatever swept far enough to prove a start saw
   *   the files it swept past
   * - an end is never below its own start
   */
  it('ships no bound that contradicts another', () => {
    for (const venue of ['okx', 'bitget']) {
      const rows = seriesFor(db, venueIdOf(db, venue));

      expect(rows.filter(one => one.tip === null && one.first === null)).toEqual([]);
      expect(rows.filter(one => one.first !== null && one.last === null)).toEqual([]);
      expect(rows.filter(one => one.last !== null && one.last < one.first!)).toEqual([]);
    }
  });

  /**
   * **The regression this exists for.** A seed that shipped its tip at the day
   * its bounds were measured made generation begin the day after the seed was
   * built. okx is not listable, so nothing else would ever have reached what lay
   * below: the catalog it produced held three weeks of a seven-year archive
   * while every listing venue held all of theirs.
   *
   * So a tip the seed does carry sits at the bottom of its dataset's archive
   * rather than anywhere near today. A row whose start is already known carries
   * none at all — there is nothing to guess, and the preamble floors it from the
   * start before generation runs.
   */
  it('ships a tip below the archive, not at the day it was built', () => {
    for (const venue of ['okx', 'bitget']) {
      const tips = seriesFor(db, venueIdOf(db, venue))
        .map(one => one.tip).filter((at): at is string => at !== null);

      expect(tips.length).toBeGreaterThan(0);
      expect(tips.filter(at => at.slice(0, 4) > '2026')).toEqual([]);
    }
  });

  /** Which is what makes the first update the backfill. */
  it('generates from the floor it recorded, not from the day it was built', () => {
    const venueId = venueIdOf(db, 'okx');

    const oldest = seriesFor(db, venueId, { live: true })
      .filter(one => one.symbol !== '@' && one.tip !== null)
      .sort((a, b) => a.tip!.localeCompare(b.tip!))[0]!;

    const page = updatePage(db, venueId, String(oldest.id), null, { slots: okx.slotsFor });

    expect(page.listed.length).toBeGreaterThan(0);
    expect(page.listed[0]!.key).toContain(oldest.tip!.slice(0, 4));
  });

  /**
   * **Every seeded series is open**, because none of them has an end. That is
   * the shape of a seed with no bounds: nothing is closed until something
   * measures it closed.
   */
  it('generates for every series it ships', () => {
    const venueId = venueIdOf(db, 'bitget');

    expect(updateScopes(db, venueId)).toHaveLength(seriesFor(db, venueId).length);
  });

  /**
   * **A pattern's state is part of what a seed states.** Okx wrote its last
   * plain-tree order book before moving to `pro/L2/`, so the old shape is
   * history rather than something a symbol listing tomorrow publishes to — and a
   * preamble reading active patterns must not offer it one.
   *
   * It does not stop the *existing* series being generated for: the archive
   * under a dead naming is still there to be read.
   */
  it('retires the order-book tree okx stopped writing to', () => {
    const books = seriesFor(db, venueIdOf(db, 'okx'))
      .filter(one => one.pattern.includes('/L2/'));

    const plain = books.filter(one => ! one.pattern.includes('/pro/L2/'));
    const pro   = books.filter(one =>   one.pattern.includes('/pro/L2/'));

    expect(plain.length).toBeGreaterThan(0);
    expect(pro.length).toBeGreaterThan(0);

    expect(plain.every(one => one.retiredAt === '20260804')).toBe(true);
    expect(pro.every(one => one.retiredAt === null)).toBe(true);
  });

  /**
   * **Bitget renamed its files twice**, and each naming is a pattern of its own
   * rather than a special case anywhere in the core. The two it abandoned are
   * retired; the one it writes today is not.
   */
  it('retires the two namings bitget abandoned, and keeps the third', () => {
    const rows    = seriesFor(db, venueIdOf(db, 'bitget'));
    const shapes  = new Map(rows.map(one => [one.pattern, one.retiredAt]));
    const retired = [...shapes.values()].filter(at => at !== null);

    /**
     * Twenty-six shapes, ten of them retired, and neither number is a sum of
     * eras alone.
     *
     * The archive publishes daily files *and* monthly bundles, and the margin
     * token that once tripled every futures trades shape is a transform rather
     * than three patterns. What is retired is the two dead daily namings across
     * klines, trades and depth, in both halves of the venue - four at the 2024
     * cut, which predates depth, and six at the 2026 one. Books and the monthly
     * bundles have never been renamed and are all live.
     *
     * **A shape retires venue-wide.** It is the venue that stopped writing it,
     * so the date is the last any market served it: a handful of instruments in
     * `unknown` whose files stop early retire nothing.
     */
    expect(shapes.size).toBe(26);
    expect(retired).toHaveLength(10);

    /**
     * **The date is what makes it useful.** Both dead namings stopped on a day
     * the archive itself states — measured off bitget's index, and the ceiling
     * generation now stops at rather than running on to yesterday.
     */
    expect(shapes.get('kline/{SYMBOL}/SP/{SYMBOL}_SP_1min_{YYYY}{MM}{DD}.zip')).toBe(null);
    expect(shapes.get('kline/{SYMBOL}/SP/{YYYY}{MM}{DD}.zip')).toBe('20260817');
    expect(shapes.get('kline/{SYMBOL}/{SYMBOL}_SP_1min_{YYYY}{MM}{DD}.zip')).toBe('20240418');
  });

  /**
   * **A shape that ended is a ceiling, and this is the whole point of a date.**
   *
   * Without one, the pass that discovers a retired naming asks it for every day
   * from its floor to yesterday — 21.6 M keys across bitget's superseded
   * namings, every one of them certain to answer 403.
   */
  it('stops generating a dead shape at the day it died', () => {
    const venueId = venueIdOf(db, 'bitget');

    const dead = seriesFor(db, venueId)
      .find(one => one.pattern === 'kline/{SYMBOL}/{SYMBOL}_SP_1min_{YYYY}{MM}{DD}.zip')!;

    const keys = [];

    for (let page = updatePage(db, venueId, String(dead.id), null), guard = 0;
      page.listed.length > 0 && guard < 20; guard++) {
      keys.push(...page.listed);

      if (page.cursor === null) break;

      page = updatePage(db, venueId, String(dead.id), page.cursor);
    }

    expect(keys.length).toBeGreaterThan(0);
    expect(keys[keys.length - 1]!.key).toContain('20240418');
  });
});


/**
 * **A seed's date is declared, and has to stay true to its contents.** A
 * backfill leaves out the span between a series' newest seeded file and this
 * date, on the strength of the seeding pass having looked that far — so a date
 * that has fallen behind the file it sits beside would claim a span nobody
 * proved.
 */
describe('when a seed was built', () => {
  const newest = (venue: string): string => {
    const lines = readFileSync(
      join(__dirname, `../src/database/migrations/seeds/${venue}/series.csv`), 'utf8')
      .trim().split('\n');

    const at = lines[0]!.split(',').indexOf('last');

    return lines.slice(1)
      .map(line => (line.split(',')[at] ?? '').padEnd(8, '0'))
      .filter(Boolean)
      .reduce((high, one) => (one > high ? one : high), '');
  };

  for (const venue of ['okx'])
    it(`is stated for ${venue}, and not behind what that seed records`, () => {
      const at = seriesSeededAt(venue);

      expect(at).toMatch(/^\d{8}$/);

      /** The pass that saw the newest file cannot have looked less far than that. */
      expect(at! >= newest(venue)).toBe(true);
    });

  /**
   * **bitget's horizon is deliberately withheld while its seed is experimental.**
   * A seed whose bounds came from the download index may not also be trusted to
   * say what the index was silent about — see `SEEDED_AT`. This asserts the
   * withholding so that restoring it is a deliberate edit rather than a drift.
   */
  it('answers nothing for a venue whose seed is still being measured', () => {
    expect(seriesSeededAt('bitget')).toBeNull();
  });

  /** htx seeds shapes and no series, so there is no span to leave out. */
  it('answers nothing for a venue that seeds no series', () => {
    expect(seriesSeededAt('htx')).toBeNull();
  });

  it('answers nothing for a venue with no seed at all', () => {
    expect(seriesSeededAt('binance')).toBeNull();
  });
});
