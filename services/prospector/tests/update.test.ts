import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  flushTips, loadSeries, putVenue, putFiles, recordSeries, retirePattern, settleWalk,
  updateSeries,
} from '../src/catalog';
import { openCatalog } from '../src/database';
import { updatePage, updateScopes } from '../src/update';
import type { Rules } from '../src/update';
import type { Found } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Generating what a venue has published since we last looked.
 *
 * **The keyspace nobody fetches.** Every venue ends here: an indexed one once
 * its walk is behind it, an unlisted one from the start. What it must get right
 * is the boundaries — start after the tip, stop at the last complete period —
 * because being wrong low costs probes and being wrong high loses files.
 */

let dir: string;
let db:  DatabaseSync;
let id:  number;

/** A fixed clock, so "yesterday" is a fact rather than whenever this runs. */
const NOW = new Date('2026-03-10T09:00:00.000Z');

const DAILY   = 'x/{YYYY}{MM}{DD}/{SYMBOL}-trades-{YYYY}-{MM}-{DD}.zip';
const MONTHLY = 'x/{YYYY}{MM}/{SYMBOL}-trades-{YYYY}-{MM}.zip';

const found = (over: Partial<Found> = {}): Found => ({
  market: 'SPOT', dataset: 'trades', symbol: 'BTC-USDT', pattern: DAILY, ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'update-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });
  id  = putVenue(db, 'demo', 'https://x', '');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const keys = (scope: string, rules: Rules = {}): string[] => {
  const out: string[] = [];

  let cursor: string | null = null;

  do {
    const page = updatePage(db, id, scope, cursor, rules, NOW);

    out.push(...page.listed.map(one => one.key));
    cursor = page.cursor;
  } while (cursor);

  return out;
};

describe('what an update generates', () => {
  /**
   * **From the tip, not from the start.** Everything at or below the tip is
   * already recorded; asking again would be the entire backfill, every pass.
   */
  it('starts the day after the tip and stops at yesterday', () => {
    const row = recordSeries(db, id, found(), { tip: '20260305', first: '20240101' });
    const out = keys(String(row.id));

    expect(out[0]).toBe('x/20260306/BTC-USDT-trades-2026-03-06.zip');
    expect(out.at(-1)).toBe('x/20260309/BTC-USDT-trades-2026-03-09.zip');
    expect(out).toHaveLength(4);
  });

  /**
   * **A seed states a tip below the archive**, which is what makes a seeded
   * venue's first update its backfill — using the same code as its hundredth,
   * and without generation needing a second rule for it.
   */
  it('backfills from a tip that sits below the start', () => {
    const row = recordSeries(db, id, found(), { first: '20260301', tip: '20260228' });

    expect(keys(String(row.id))[0]).toBe('x/20260301/BTC-USDT-trades-2026-03-01.zip');
  });

  /**
   * **`last` does not bound the range.** It used to clamp generation, which was
   * the only way to stop a finished series asking for ever — and it cost the
   * catalog the ability to say where a series had reached, since the field had
   * to be left NULL to mean "more is expected".
   *
   * Whether to generate at all is now `open`'s answer; how far is the calendar's.
   * A series still open is asked about up to the frontier however old its newest
   * file is, which is what lets that date stay a measurement.
   */
  it('generates up to the frontier whatever the newest file was', () => {
    const row = recordSeries(db, id, found(),
      { tip: '20260305', first: '20240101', last: '20260307' });

    expect(keys(String(row.id))).toEqual([
      'x/20260306/BTC-USDT-trades-2026-03-06.zip',
      'x/20260307/BTC-USDT-trades-2026-03-07.zip',
      'x/20260308/BTC-USDT-trades-2026-03-08.zip',
      'x/20260309/BTC-USDT-trades-2026-03-09.zip',
    ]);
  });

  /**
   * **A start is a floor.** Nothing was published before the series began, so a
   * tip sitting under it would spend the gap asking about days known to hold
   * nothing — which is what a seed stating one floor for a whole dataset does.
   */
  it('never generates below the start', () => {
    const row = recordSeries(db, id, found(), { tip: '20240101', first: '20260305' });

    expect(keys(String(row.id))[0]).toBe('x/20260305/BTC-USDT-trades-2026-03-05.zip');
  });

  /** Today's file is unfinished rather than late, and tomorrow's is not a candidate. */
  it('never asks about today', () => {
    const row = recordSeries(db, id, found(), { tip: '20260308', first: '20240101' });

    expect(keys(String(row.id)).some(one => one.includes('20260310'))).toBe(false);
  });

  /**
   * A monthly shape stops at the last month that has closed: the current month's
   * file cannot exist until the month ends.
   */
  it('stops a monthly series at the last closed month', () => {
    const row = recordSeries(db, id, found({ pattern: MONTHLY }),
      { first: '202512', tip: '202511' });

    expect(keys(String(row.id))).toEqual([
      'x/202512/BTC-USDT-trades-2025-12.zip',
      'x/202601/BTC-USDT-trades-2026-01.zip',
      'x/202602/BTC-USDT-trades-2026-02.zip',
    ]);
  });

  /** A month bound on a daily shape means the first of that month. */
  it('reads a month-grained bound at the series own grain', () => {
    const row = recordSeries(db, id, found(), { first: '202602', tip: '202602' });

    expect(keys(String(row.id))[0]).toBe('x/20260202/BTC-USDT-trades-2026-02-02.zip');
  });

  it('generates nothing when the tip is already at the last complete period', () => {
    const row = recordSeries(db, id, found(), { tip: '20260309', first: '20240101' });

    expect(keys(String(row.id))).toEqual([]);
  });

  /**
   * **The archive's spelling is recorded on the series, not reapplied per pass.**
   *
   * It used to be a rule handed to generation, which meant the rule that writes a
   * URL and the rule that reads one back had to agree for ever — and where they
   * did not, one instrument quietly became two series. Now a key is the pattern
   * with a recorded name and a date in it, and nothing else.
   */
  it('spells the instrument the way the archive does', () => {
    const row = recordSeries(db, id,
      { ...found({ market: 'future' }), urlSymbol: 'BTC-USDT-chain' },
      { tip: '20260308', first: '20240101' });

    expect(keys(String(row.id))[0]).toBe('x/20260309/BTC-USDT-chain-trades-2026-03-09.zip');
  });
});

describe('which series an update walks', () => {
  it('offers one scope per series that is still worth pursuing', () => {
    const live = recordSeries(db, id, found(), { first: '20260301', tip: '20260301' });

    recordSeries(db, id, found({ symbol: 'DEAD' }),
      { first: null, found: false, state: 'void' });

    expect(updateScopes(db, id)).toEqual([String(live.id)]);
  });

  /** A series with no start has never published, so there is nothing to ask for. */
  it('leaves out a series that has never published', () => {
    recordSeries(db, id, found(), { first: null, found: false });

    expect(updateScopes(db, id)).toEqual([]);
  });

  /**
   * **A retired pattern with nothing established still generates.** okx moved
   * its order books under `pro/L2/`, so the preamble gives a newly listed
   * instrument no series on the old shape — but a series already sitting there
   * that has never published is one this catalog still owes an answer for, and
   * refusing to ask is how it would never get one.
   */
  it('keeps a series on a retired pattern that has published nothing', () => {
    const row = recordSeries(db, id, found(), { first: '20260301', tip: '20260301' });

    expect(updateScopes(db, id)).toEqual([String(row.id)]);

    retirePattern(db, row.patternId, '20240102');

    expect(updateScopes(db, id)).toEqual([String(row.id)]);
  });

  /**
   * **A live instrument on a live shape is asked about however old its newest
   * file is.** The venue still lists it and still writes this shape, which
   * outweighs any quiet spell — a fortnight's silence is not an ending.
   */
  it('keeps a listed instrument whose files went quiet', () => {
    const row = recordSeries(db, id, found(), { first: '20240101', tip: '20260301' });

    updateSeries(db, { ...row, last: '20240102' });

    expect(updateScopes(db, id)).toEqual([String(row.id)]);
  });

  /**
   * **What closes a series is a dead shape and a stale measurement together.**
   *
   * htx's old tree, bitget's two dead naming eras and okx's pre-`pro/L2/` books
   * are 132,397 series whose instruments are alive and whose shapes are
   * finished. Reading the instrument alone would keep every one of them
   * generating to yesterday for ever.
   */
  it('leaves out a retired shape whose files stopped long ago', () => {
    const row = recordSeries(db, id, found(), { first: '20240101', tip: '20260301' });

    updateSeries(db, { ...row, last: '20240102' });
    retirePattern(db, row.patternId, '20240102');

    expect(updateScopes(db, id)).toEqual([]);
  });

  /** The same shape, still being written: inside the window, so still asked about. */
  it('keeps a retired shape whose files are still arriving', () => {
    const row = recordSeries(db, id, found(), { first: '20240101', tip: '20260301' });

    updateSeries(db, { ...row, last: '20260301' });
    retirePattern(db, row.patternId, '20240102');

    expect(updateScopes(db, id)).toEqual([String(row.id)]);
  });

  /** Delisted and gone quiet is the other way a series closes. */
  it('leaves out a delisted instrument whose files stopped long ago', () => {
    const row = recordSeries(db, id, found(), { first: '20240101', tip: '20260301' });

    updateSeries(db, { ...row, last: '20240102', state: 'delisted' });

    expect(updateScopes(db, id)).toEqual([]);
  });
});

describe('resuming an update', () => {
  /** A page hands back where it stopped, and the next one carries on from it. */
  it('continues from its cursor without repeating or losing a key', () => {
    // Long enough to need more than one page, which is the only case that can
    // repeat or lose anything.
    const row = recordSeries(db, id, found(), { first: '20200101', tip: '20191231' });
    const all = keys(String(row.id));

    const first = updatePage(db, id, String(row.id), null, undefined, NOW);
    const rest  = updatePage(db, id, String(row.id), first.cursor, undefined, NOW);

    expect(first.listed).toHaveLength(1_000);
    expect([...first.listed, ...rest.listed].map(one => one.key)).toEqual(all.slice(0, 1_000 + rest.listed.length));
    expect(new Set(all).size).toBe(all.length);
  });

  /**
   * A walk that finished on this day settles every tip at `OVERDUE_DAYS` back,
   * which for a daily series is the 7th — so generation resumes on the 8th.
   */
  const WALKED = new Date('2026-03-23T00:00:00Z');

  /** A flushed tip is where the next update starts, which is the whole point of it. */
  it('starts from a tip that was written out', () => {
    const row = recordSeries(db, id, found(), { tip: '20260306', first: '20240101' });

    // Moved in memory, then written out and read back, which is the whole path a
    // tip takes between one update and the next.
    settleWalk(db, id, WALKED);
    flushTips(db);
    loadSeries(db);

    expect(keys(String(row.id))[0]).toBe('x/20260308/BTC-USDT-trades-2026-03-08.zip');
  });
});

/**
 * **The tip is the only thing generation needs**, and every path that creates a
 * series states one: a walk from the first file it sees, a seed from below the
 * archive's start, the preamble from what the last completed pass covered.
 */
describe('what counts as worth generating for', () => {
  it('generates for a series with a tip and no measured start', () => {
    const row = recordSeries(db, id, found(), { first: null, tip: '20260301' });

    expect(updateScopes(db, id)).toEqual([String(row.id)]);
  });

  /**
   * **A row with no tip is one nothing states a bound for**, written by code
   * that no longer exists. Falling back to `first` is the guess this design
   * removed, so it is skipped and counted rather than generated from.
   */
  it('skips a series with no tip rather than falling back to its start', () => {
    recordSeries(db, id, found(), { first: '20260301', tip: null });

    expect(updateScopes(db, id)).toEqual([]);
  });

  /** Asked about, and it publishes nothing. */
  it('skips a series that has never been shown to publish', () => {
    recordSeries(db, id, found(), { first: null, tip: null, found: false });

    expect(updateScopes(db, id)).toEqual([]);
  });
});

/**
 * **A file is not an ending.** Generation runs between the tip and the frontier;
 * what a series has already been seen to publish says nothing about whether more
 * is owed above it. A shortcut here — stopping a live series at its first file —
 * saved probes during a seed rebuild and stopped live series being extended,
 * which is why it does not live in the core.
 */
describe('what a file does not do', () => {
  const filed = async (series: { id?: number }, date: string) =>
    putFiles(db, [{
      venueId: id, path: `p/${date}`, date, size: 1, etag: 'e', modified: null,
      existence: 'confirmed', seriesId: series.id!, seenAt: 'T1',
    }], true);

  it('keeps generating for a listed series that already has one', async () => {
    const row = recordSeries(db, id, found(), { tip: '20260301', first: null });

    await filed(row, '20260302');

    expect(keys(String(row.id)).length).toBeGreaterThan(0);
  });

  /** A delisted series still needs its end, so it is walked to the finish. */
  it('keeps generating for a delisted series that has files', async () => {
    const row = recordSeries(db, id, found({ symbol: 'GONE' }),
      { tip: '20260301', first: null, state: 'delisted' });

    await filed(row, '20260302');

    expect(keys(String(row.id)).length).toBeGreaterThan(0);
  });
});


/**
 * **A seed that recorded where a series had got to also proved what lay above
 * it.** The pass that built it went on looking until the day it was written, so
 * the span between a series' newest seeded file and that day is measured
 * absence. Asking again is the difference between a first pass that walks the
 * whole calendar and one that walks what nobody has answered for — years of it,
 * across thousands of series.
 */
describe('the span a seed already proved empty', () => {
  /** The seed's own horizon, as `seriesSeededAt` reads it from the file. */
  const SEEDED = { seededAt: '20260301' };

  it('skips from the seeded last up to the seed horizon, and asks about the rest', () => {
    const row = recordSeries(db, id, found(), { tip: '20251231', last: '20260101', state: 'delisted' });

    const asked = keys(String(row.id), SEEDED);

    /** Below is ordinary history and still asked about — the tip is 20251231. */
    expect(asked.some(key => key.includes('2026-01-01'))).toBe(true);

    /** The proven span is not. */
    expect(asked.some(key => key.includes('2026-01-15'))).toBe(false);
    expect(asked.some(key => key.includes('2026-02-10'))).toBe(false);

    /** And the tail above the horizon is, because it may have resumed. */
    expect(asked.some(key => key.includes('2026-02-13'))).toBe(false);
    expect(asked.some(key => key.includes('2026-02-14'))).toBe(true);
    expect(asked.at(-1)).toContain('2026-03-09');
  });

  it('asks about everything where no seed says otherwise', () => {
    const row = recordSeries(db, id, found(), { tip: '20251231', last: '20260101', state: 'delisted' });

    const asked = keys(String(row.id));

    expect(asked.some(key => key.includes('2026-01-15'))).toBe(true);
    expect(asked.some(key => key.includes('2026-02-10'))).toBe(true);
  });

  /** Nothing was witnessed, so nothing above is proven either. */
  it('skips nothing for a series the seed gave no last', () => {
    const row = recordSeries(db, id, found({ symbol: 'QUIET' }), { tip: '20251231', last: null });

    const asked = keys(String(row.id), SEEDED);

    expect(asked.some(key => key.includes('2026-01-15'))).toBe(true);
    expect(asked.some(key => key.includes('2026-02-10'))).toBe(true);
  });

  /**
   * **A resume jumps the span exactly as the first attempt did.** The horizon is
   * fixed and a `last` only rises, so picking the loop up from a cursor under
   * the span answers the same question — never a wider one.
   */
  it('jumps the span when resumed from a cursor beneath it', () => {
    const row = recordSeries(db, id, found({ symbol: 'RESUMED' }),
      { tip: '20251231', last: '20260101', state: 'delisted' });

    /** As if a pass had stopped on the last key below the proven span. */
    const page = updatePage(db, id, String(row.id), '20260101', SEEDED, NOW);

    expect(page.listed[0]!.key).toContain('2026-02-14');
    expect(page.listed.some(one => one.key.includes('2026-02-10'))).toBe(false);
  });
});
