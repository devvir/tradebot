import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { catchUp, editLens, lenses, lensNamed, putLens } from '@tradebot/lenses';
import { changeLens, openScratch, putFiles, putVenue, recordSeries, storeLens, worked } from './fixture';
import type { DatabaseSync } from 'node:sqlite';

/**
 * A lens's rows in `lens_member`: worked out again when its rules are saved,
 * and settled as partitions arrive, siblings together.
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
    storeLens(db, 'all', 'all', '', { format: 1, venues: { '*': [{ effect: 'include' }] } });

    expect(members('all')).toEqual(['binance 202001', 'binance 202101', 'gate 202001']);
  });

  it('leaves out the months its rules do not reach', () => {
    storeLens(db, 'old', 'old', '', { format: 1, venues: { '*': [{ effect: 'include', to: '202012' }] } });

    expect(members('old')).toEqual(['binance 202001', 'gate 202001']);
  });
});

describe('a save', () => {
  /** Storing a lens is one thing and working out what it lets through another: the first answers without the second. */
  it('answers before anything is worked out, and says the lens is updating', () => {
    const made = putLens(db, 'all', 'all', '', { format: 1, venues: { '*': [{ effect: 'include' }] } });

    expect(made).toMatchObject({ slug: 'all', updating: true });
    expect(members('all')).toEqual([]);

    expect(worked(db, 'all')).toMatchObject({ updating: false });
    expect(members('all')).toEqual(['binance 202001', 'binance 202101', 'gate 202001']);
  });

  /** Until the walk reaches them, a lens's partitions are the ones its rules before let through. */
  it('leaves what the lens let through in place until new rules are worked out', () => {
    storeLens(db, 'all', 'all', '', { format: 1, venues: { '*': [{ effect: 'include' }] } });

    const saved = editLens(db, 'all', { definition: { format: 1, venues: { '*': [{ effect: 'include', to: '202012' }] } } });

    expect(saved).toMatchObject({ updating: true });
    expect(members('all')).toEqual(['binance 202001', 'binance 202101', 'gate 202001']);

    worked(db, 'all');

    expect(members('all')).toEqual(['binance 202001', 'gate 202001']);
  });

  /** A venue the new rules say nothing of has rows to lose, and loses them. */
  it('takes out what a venue no longer in the lens was let through', () => {
    storeLens(db, 'both', 'both', '', { format: 1, venues: { binance: [{ effect: 'include' }], gate: [{ effect: 'include' }] } });

    changeLens(db, 'both', { definition: { format: 1, venues: { binance: [{ effect: 'include' }] } } });

    expect(members('both')).toEqual(['binance 202001', 'binance 202101']);
  });

  it('touches no row, and works nothing out, where only the name or the note changed', () => {
    storeLens(db, 'both', 'both', '', { format: 1, venues: { '*': [{ effect: 'include' }] } });

    forget('both', 'gate');

    expect(editLens(db, 'both', { name: 'renamed', note: 'and noted' })).toMatchObject({ updating: false });
    expect(members('both')).toEqual(['binance 202001', 'binance 202101']);
  });
});

/**
 * A month of a dataset published in more than one form — monthly and daily, per
 * instrument and for the whole market — is as many partitions, and a rule that
 * prefers a form keeps that one where it is there.
 */
describe('a rule that prefers a form', () => {
  /** A file of gate's klines in March 2021, in the form given; each form is a slice, and its month a partition. */
  const publish = async (grain: 'monthly' | 'daily', bundle: 'instrument' | 'market' = 'instrument'): Promise<void> => {
    const symbol = bundle === 'market' ? '@' : 'BTC_USDT';
    const id     = recordSeries(db, gate, { market: 'spot', dataset: 'klines', variant: '1m', symbol,
      pattern: grain === 'daily' ? `k/${bundle}/{YYYY}{MM}{DD}.zip` : `k/${bundle}/{YYYY}{MM}.zip` }).id;

    await putFiles(db, [{ venueId: gate, seriesId: id, path: `k/${grain}/${bundle}`, date: grain === 'daily' ? '20210301' : '202103' }]);
  };

  /** The forms of March's klines a lens lets through. */
  const forms = (slug: string): string[] =>
    (db.prepare(
      `SELECT c.grain || ' ' || c.bundle AS form FROM lens_member l
         JOIN partition q ON q.id = l.partition_id JOIN slice c ON c.id = q.slice_id
        WHERE l.lens_id = (SELECT id FROM lens WHERE slug = ?) AND c.dataset = 'klines' ORDER BY 1`).all(slug) as
      { form: string }[]).map(one => one.form);

  const klines = (rule: object) =>
    ({ format: 1, venues: { gate: [{ effect: 'include' as const, datasets: [{ dataset: 'klines' }], ...rule }] } });

  it('keeps what there is where the preferred form is not published', async () => {
    await publish('daily');

    storeLens(db, 'k', '', '', klines({ grain: { prefer: 'monthly' } }));

    expect(forms('k')).toEqual(['daily instrument']);
  });

  it('keeps the preferred form alone where both are published', async () => {
    await publish('daily');
    await publish('monthly');

    storeLens(db, 'k', '', '', klines({ grain: { prefer: 'monthly' } }));

    expect(forms('k')).toEqual(['monthly instrument']);
  });

  /** Dailies are published through the month and the monthly file after it: the daily month leaves when its sibling appears. */
  it('lets go of the other form when the preferred one appears', async () => {
    await publish('daily');

    storeLens(db, 'k', '', '', klines({ grain: { prefer: 'monthly' } }));

    await publish('monthly');
    worked(db, 'k');

    expect(forms('k')).toEqual(['monthly instrument']);
  });

  it('never takes in the other form when it appears after the preferred one', async () => {
    await publish('daily');

    storeLens(db, 'k', '', '', klines({ grain: { prefer: 'daily' } }));

    await publish('monthly');
    worked(db, 'k');

    expect(forms('k')).toEqual(['daily instrument']);
  });

  /** Only narrows, and where the month is not published that way it matches nothing of it. */
  it('is not what taking one form alone does', async () => {
    await publish('daily');

    storeLens(db, 'k', '', '', klines({ grain: { only: 'monthly' } }));

    expect(forms('k')).toEqual([]);
  });

  /** The bundle is settled first, then the grain within it. */
  it('settles the bundle before the grain where a rule prefers both', async () => {
    await publish('monthly', 'market');
    await publish('daily', 'instrument');

    storeLens(db, 'k', '', '', klines({ grain: { prefer: 'monthly' }, bundle: { prefer: 'instrument' } }));

    expect(forms('k')).toEqual(['daily instrument']);

    await publish('monthly', 'instrument');
    worked(db, 'k');

    expect(forms('k')).toEqual(['monthly instrument']);
  });

  /** Each include keeps what it keeps; a second rule that takes the other form brings it back. */
  it('adds up with another rule that lets the other form through', async () => {
    await publish('daily');
    await publish('monthly');

    storeLens(db, 'k', '', '', { format: 1, venues: { gate: [
      { effect: 'include', datasets: [{ dataset: 'klines' }], grain: { prefer: 'monthly' } },
      { effect: 'include', datasets: [{ dataset: 'klines' }], grain: { only: 'daily' } },
    ] } });

    expect(forms('k')).toEqual(['daily instrument', 'monthly instrument']);
  });
});

describe('catching up', () => {
  /** Partitions that arrive are folded in a step at a time, and the lens remembers how far it has read. */
  it('folds in the partitions that appeared since the lens last looked', async () => {
    storeLens(db, 'gate', 'gate', '', { format: 1, venues: { gate: [{ effect: 'include' }] } });

    await file(gate, series(gate, 'ETH_USDT'), '202102');
    await file(binance, series(binance, 'SOLUSDT'), '202102');

    const [lens] = lenses(db);

    expect(catchUp(db, lens!, 1)).toBe(true);

    while (catchUp(db, lens!, 1));

    expect(members('gate')).toEqual(['gate 202001', 'gate 202102']);
    expect((db.prepare('SELECT partitions_through AS at FROM lens WHERE id = ?').get(lensNamed(db, 'gate')!.id!) as { at: number }).at)
      .toBe(5);
    expect(catchUp(db, lens!, 1)).toBe(false);
  });
});
