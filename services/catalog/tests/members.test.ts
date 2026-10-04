import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editLens, lenses, lensNamed, putLens } from '../src/lenses/lens';
import { keepCurrent } from '../src/lenses/members';
import { openScratch, putFiles, putVenue, recordSeries } from './fixture';
import type { DatabaseSync } from 'node:sqlite';

/**
 * A lens's rows in `lens_member`: rebuilt for the venues a save changed, and
 * extended in the background as partitions arrive. See `members.ts`.
 */

let dir: string;
let db:  DatabaseSync;
let binance: number;
let gate:    number;

const series = (venue: number, symbol: string): number =>
  recordSeries(db, venue, { market: 'spot', dataset: 'trades', symbol, pattern: `t/{YYYY}{MM}/${symbol}.zip` }).id;

/** One file of a series in a month, which is what makes that month a partition. */
const file = async (venueId: number, seriesId: number, month: string): Promise<void> =>
  putFiles(db, [{ venueId, seriesId, path: `${seriesId}/${month}`, date: month }]);

/** The partitions a lens holds, as `venue month`. */
const members = (slug: string): string[] =>
  (db.prepare(
    `SELECT c.venue, q.month FROM lens_member l
       JOIN partition q ON q.id = l.partition_id JOIN slice c ON c.id = q.slice_id
      WHERE l.lens_id = (SELECT id FROM lens WHERE slug = ?) ORDER BY c.venue, q.month`).all(slug) as
    { venue: string; month: string }[]).map(one => `${one.venue} ${one.month}`);

/** Take a venue's rows out from under a lens, so a rebuild of that venue is what puts them back. */
const forget = (slug: string, venue: string): void => {
  db.prepare(
    `DELETE FROM lens_member WHERE lens_id = (SELECT id FROM lens WHERE slug = ?)
        AND partition_id IN (SELECT q.id FROM partition q JOIN slice c ON c.id = q.slice_id
                              WHERE c.venue = ?)`).run(slug, venue);
};

beforeEach(async () => {
  dir     = mkdtempSync(join(tmpdir(), 'members-'));
  db      = openScratch(join(dir, 'catalog.db'));
  binance = putVenue(db, 'binance', 'https://b');
  gate    = putVenue(db, 'gate', 'https://g');

  const btc = series(binance, 'BTCUSDT');

  await file(binance, btc, '202001');
  await file(binance, btc, '202101');
  await file(binance, series(binance, 'ETHUSDT'), '202101');
  await file(gate, series(gate, 'BTC_USDT'), '202001');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('what a lens holds', () => {
  /** Two instruments of one slice in one month are one partition, and one row. */
  it('is one row per partition it lets through', () => {
    putLens(db, 'all', 'all', '', { format: 1, venues: { '*': [{ effect: 'include' }] } });

    expect(members('all')).toEqual(['binance 202001', 'binance 202101', 'gate 202001']);
  });

  it('leaves out the months its rules do not reach', () => {
    putLens(db, 'old', 'old', '', { format: 1, venues: { '*': [{ effect: 'include', to: '202012' }] } });

    expect(members('old')).toEqual(['binance 202001', 'gate 202001']);
  });
});

describe('a save', () => {
  /** A change to one venue's rules can only move that venue's partitions. */
  it('rebuilds only the venues whose rules it changed', () => {
    putLens(db, 'both', 'both', '', { format: 1, venues: {
      binance: [{ effect: 'include' }],
      gate:    [{ effect: 'include' }],
    } });

    forget('both', 'gate');

    editLens(db, 'both', { definition: { format: 1, venues: {
      binance: [{ effect: 'include', to: '202012' }],
      gate:    [{ effect: 'include' }],
    } } });

    // Binance is evaluated again; gate's rows are not put back, since nothing rebuilt them.
    expect(members('both')).toEqual(['binance 202001']);
  });

  it('touches no row where only the name or the note changed', () => {
    putLens(db, 'both', 'both', '', { format: 1, venues: { '*': [{ effect: 'include' }] } });

    forget('both', 'gate');

    editLens(db, 'both', { name: 'renamed', note: 'and noted' });

    expect(members('both')).toEqual(['binance 202001', 'binance 202101']);
  });

  /** The global rules reach every venue, so a change to them rebuilds them all. */
  it('rebuilds every venue where the global rules changed', () => {
    putLens(db, 'all', 'all', '', { format: 1, venues: { '*': [{ effect: 'include' }] } });

    forget('all', 'gate');

    editLens(db, 'all', { definition: { format: 1, venues: { '*': [{ effect: 'include', to: '202012' }] } } });

    expect(members('all')).toEqual(['binance 202001', 'gate 202001']);
  });
});

describe('keeping current', () => {
  /** Partitions that arrive are folded in without anybody asking through the lens. */
  it('folds in partitions that appeared, in the background', async () => {
    putLens(db, 'gate', 'gate', '', { format: 1, venues: { gate: [{ effect: 'include' }] } });

    await file(gate, series(gate, 'ETH_USDT'), '202102');
    await file(binance, series(binance, 'SOLUSDT'), '202102');

    const stop = keepCurrent(db, () => lenses(db));

    try {
      await new Promise(done => setTimeout(done, 50));

      expect(members('gate')).toEqual(['gate 202001', 'gate 202102']);
      expect((db.prepare('SELECT partitions_through AS at FROM lens WHERE id = ?').get(lensNamed(db, 'gate')!.id!) as { at: number }).at)
        .toBe(5);
    } finally {
      stop();
    }
  });
});
