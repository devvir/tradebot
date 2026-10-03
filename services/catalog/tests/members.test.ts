import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editLens, lenses, lensNamed, putLens } from '../src/lenses/lens';
import { keepCurrent } from '../src/lenses/members';
import { openScratch, putVenue, recordSeries } from './fixture';
import type { DatabaseSync } from 'node:sqlite';

/**
 * A lens's rows in `lens_series`: rebuilt for the venues a save changed, and
 * extended in the background as series arrive. See `members.ts`.
 */

let dir: string;
let db:  DatabaseSync;
let binance: number;
let gate:    number;

const series = (venue: number, symbol: string) =>
  recordSeries(db, venue, { market: 'spot', dataset: 'trades', symbol, pattern: `t/{YYYY}{MM}/${symbol}.zip` }).id;

/** The rows a lens holds, as `rowid series lo hi`, so a row rewritten reads differently from one left alone. */
const rows = (slug: string): string[] =>
  (db.prepare(`SELECT rowid AS id, series_id AS seriesId, lo, hi FROM lens_series
                WHERE lens_id = (SELECT id FROM lens WHERE slug = ?) ORDER BY series_id`).all(slug) as
    { id: number; seriesId: number; lo: string; hi: string }[]).map(one => `${one.id} ${one.seriesId} ${one.lo} ${one.hi}`);

beforeEach(() => {
  dir     = mkdtempSync(join(tmpdir(), 'members-'));
  db      = openScratch(join(dir, 'catalog.db'));
  binance = putVenue(db, 'binance', 'https://b');
  gate    = putVenue(db, 'gate', 'https://g');

  series(binance, 'BTCUSDT');
  series(binance, 'ETHUSDT');
  series(gate, 'BTC_USDT');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a save', () => {
  /** A change to one venue's rules can only move that venue's series. */
  it('rebuilds only the venues whose rules it changed', () => {
    putLens(db, 'both', 'both', '', { format: 1, venues: {
      binance: [{ effect: 'include' }],
      gate:    [{ effect: 'include' }],
    } });

    const before = rows('both');

    editLens(db, 'both', { definition: { format: 1, venues: {
      binance: [{ effect: 'include', to: '202012' }],
      gate:    [{ effect: 'include' }],
    } } });

    const after = rows('both');
    const gateRow = (all: string[]) => all.find(one => one.split(' ')[1] === '3');

    expect(gateRow(after)).toBe(gateRow(before));
    expect(after.filter(one => one.endsWith('20201299'))).toHaveLength(2);
  });

  it('touches no row where only the name or the note changed', () => {
    putLens(db, 'both', 'both', '', { format: 1, venues: { '*': [{ effect: 'include' }] } });

    const before = rows('both');

    editLens(db, 'both', { name: 'renamed', note: 'and noted' });

    expect(rows('both')).toEqual(before);
  });

  /** The global rules reach every venue, so a change to them rebuilds them all. */
  it('rebuilds every venue where the global rules changed', () => {
    putLens(db, 'all', 'all', '', { format: 1, venues: { '*': [{ effect: 'include' }] } });
    editLens(db, 'all', { definition: { format: 1, venues: { '*': [{ effect: 'include', from: '202001' }] } } });

    expect(rows('all').every(one => one.split(' ')[2] === '202001')).toBe(true);
    expect(rows('all')).toHaveLength(3);
  });
});

describe('keeping current', () => {
  /** Series that arrive are folded in without anybody asking through the lens. */
  it('folds in series that appeared, in the background', async () => {
    putLens(db, 'gate', 'gate', '', { format: 1, venues: { gate: [{ effect: 'include' }] } });

    series(gate, 'ETH_USDT');
    series(binance, 'SOLUSDT');

    const stop = keepCurrent(db, () => lenses(db));

    try {
      await new Promise(done => setTimeout(done, 50));

      expect(rows('gate')).toHaveLength(2);
      expect((db.prepare('SELECT series_through AS at FROM lens WHERE id = ?').get(lensNamed(db, 'gate')!.id!) as { at: number }).at)
        .toBe(5);
    } finally {
      stop();
    }
  });
});
