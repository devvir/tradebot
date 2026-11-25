import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTransform, keyFor, putVenue, recordSeries, seriesFor } from '../src/catalog';
import { openCatalog } from '../src/database';
import type { Found, Transform } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * What an instrument substitutes where its pattern cannot say, and how soon
 * generation follows.
 *
 * Every test writes through the catalog and reads back a generated key, since a
 * key is the only thing a transform is for: a row that is in the table but not
 * in the key is the failure worth pinning.
 */

let dir: string;
let db:  DatabaseSync;
let id:  number;

const DAILY   = 'depth/{TRANSFORM:dir:{SYMBOL}}/{SYMBOL}_{YYYY}{MM}{DD}.zip';
const MONTHLY = 'depth/{TRANSFORM:dir:{SYMBOL}}/{SYMBOL}_{YYYY}{MM}.zip';

const at = (over: Partial<Found> = {}): Found => ({
  market: 'perp', dataset: 'depth', symbol: 'ABCUSDT', pattern: DAILY, ...over,
});

const row = (over: Partial<Transform> = {}): Transform => ({
  venueId: id, market: 'perp', symbol: 'ABCUSDT', dataset: '', kind: 'dir',
  transform: 'XYZ_D2', from_: '20260901', to_: null, ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'transform-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });
  id  = putVenue(db, 'demo', 'https://x', '');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a transform written while the process runs', () => {
  /**
   * **The series already exists**, which is the case a reload would otherwise
   * be needed for: a key is built from the series alone, so it is the series
   * that has to be handed the new row.
   */
  it('reaches the next key generated for a series already held', () => {
    const series = recordSeries(db, id, at(), { first: '20260101' });

    expect(keyFor(series, '20260903')).toBe('depth/ABCUSDT/ABCUSDT_20260903.zip');

    addTransform(db, row());

    const [held] = seriesFor(db, id);

    expect(keyFor(held!, '20260903')).toBe('depth/XYZ_D2/ABCUSDT_20260903.zip');
  });

  it('reaches every series of the instrument and no other', () => {
    recordSeries(db, id, at(), { first: '20260101' });
    recordSeries(db, id, at({ pattern: MONTHLY }), { first: '202601' });
    recordSeries(db, id, at({ symbol: 'DEFUSDT' }), { first: '20260101' });

    addTransform(db, row());

    const keys = seriesFor(db, id).map(one =>
      keyFor(one, one.grain === 'monthly' ? '202609' : '20260903'));

    expect(keys.sort()).toEqual([
      'depth/DEFUSDT/DEFUSDT_20260903.zip',
      'depth/XYZ_D2/ABCUSDT_202609.zip',
      'depth/XYZ_D2/ABCUSDT_20260903.zip',
    ]);
  });

  it('reaches a series recorded after it', () => {
    addTransform(db, row());

    const series = recordSeries(db, id, at(), { first: '20260101' });

    expect(keyFor(series, '20260903')).toBe('depth/XYZ_D2/ABCUSDT_20260903.zip');
  });
});

describe('which row answers', () => {
  /** "Most specific wins" whichever of the two was written first. */
  it.each([
    ['named first',    [{ dataset: 'depth', transform: 'NAMED' }, { dataset: '', transform: 'ANY' }]],
    ['catch-all first', [{ dataset: '', transform: 'ANY' }, { dataset: 'depth', transform: 'NAMED' }]],
  ])('prefers a row naming the dataset over the catch-all, %s', (_, rows) => {
    const series = recordSeries(db, id, at(), { first: '20260101' });

    for (const one of rows) addTransform(db, row(one));

    const [held] = seriesFor(db, id);

    expect(held!.id).toBe(series.id);
    expect(keyFor(held!, '20260903')).toBe('depth/NAMED/ABCUSDT_20260903.zip');
  });

  it('applies from its first date to its last, both included', () => {
    recordSeries(db, id, at(), { first: '20260101' });
    addTransform(db, row({ from_: '20260901', to_: '20260930' }));

    const [held] = seriesFor(db, id);

    expect(keyFor(held!, '20260831')).toBe('depth/ABCUSDT/ABCUSDT_20260831.zip');
    expect(keyFor(held!, '20260901')).toBe('depth/XYZ_D2/ABCUSDT_20260901.zip');
    expect(keyFor(held!, '20260930')).toBe('depth/XYZ_D2/ABCUSDT_20260930.zip');
    expect(keyFor(held!, '20261001')).toBe('depth/ABCUSDT/ABCUSDT_20261001.zip');
  });

  /** A row is written at whatever width its venue states it, and a month asks at six. */
  it('matches a monthly stamp against a row dated by the day', () => {
    recordSeries(db, id, at({ pattern: MONTHLY }), { first: '202601' });
    addTransform(db, row({ from_: '20260903', to_: '20260930' }));

    const [held] = seriesFor(db, id);

    expect(keyFor(held!, '202608')).toBe('depth/ABCUSDT/ABCUSDT_202608.zip');
    expect(keyFor(held!, '202609')).toBe('depth/XYZ_D2/ABCUSDT_202609.zip');
    expect(keyFor(held!, '202610')).toBe('depth/ABCUSDT/ABCUSDT_202610.zip');
  });
});
