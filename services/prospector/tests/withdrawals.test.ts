import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WITHDRAWALS_LOG, countUnsettled, putFiles, putVenue, recordSeries, settleFiles } from '../src/catalog';
import { openCatalog } from '../src/database';
import type { CatalogFile } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * A file a venue stops serving is rare enough to be written down, and a file
 * that was wrongly taken for gone has to be able to come back.
 */

let dir: string;
let db:  DatabaseSync;

const file = (path: string, more: Partial<CatalogFile> = {}): CatalogFile => ({
  venueId: 1, path, date: '20250301', size: 10, etag: 'e', modified: null,
  existence: 'confirmed', seenAt: 'T1',
  seriesId: recordSeries(db, 1, {
    market: 'perp', dataset: 'books', symbol: 'BTCUSDT', pattern: 'd/{SYMBOL}/{YYYY}-{MM}-{DD}.zip',
  }).id!,
  ...more,
});

/** A page of an index venue: the whole of one directory. */
const DIRECTORY = { venueId: 1, directory: 'd/', children: [] };

const logged = (): Record<string, unknown>[] =>
  (existsSync(join(dir, WITHDRAWALS_LOG)) ? readFileSync(join(dir, WITHDRAWALS_LOG), 'utf8') : '')
    .split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);

const existence = (path: string): string =>
  (db.prepare('SELECT existence FROM file WHERE path = ?').get(path) as { existence: string }).existence;

const partition = (): Record<string, number> =>
  db.prepare('SELECT files, pending, withdrawn FROM partition').get() as Record<string, number>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'withdrawals-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });

  putVenue(db, 'bybit', 'https://x', '', 'secondary');

  await putFiles(db, [file('d/a.zip'), file('d/b.zip')], DIRECTORY);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the withdrawals log', () => {
  it('is not written while nothing is withdrawn', () => {
    expect(logged()).toEqual([]);
  });

  it('names each file a walk no longer lists', async () => {
    await putFiles(db, [file('d/a.zip')], DIRECTORY);

    expect(existence('d/b.zip')).toBe('absent');
    expect(logged()).toEqual([expect.objectContaining({
      event: 'withdrawn', cause: 'walk', venue: 'bybit', host: 'secondary', path: 'd/b.zip',
      date: '20250301', size: 10, etag: 'e', downloaded: false,
    })]);
    expect(logged()[0]!['at']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('says when a listing that states the file whole brings it back', async () => {
    await putFiles(db, [file('d/a.zip')], DIRECTORY);
    await putFiles(db, [file('d/a.zip'), file('d/b.zip')], DIRECTORY);

    expect(existence('d/b.zip')).toBe('confirmed');
    expect(logged().map(one => [one['event'], one['cause'], one['path']]))
      .toEqual([['withdrawn', 'walk', 'd/b.zip'], ['returned', 'walk', 'd/b.zip']]);
  });
});

/**
 * An index that names files and states nothing else: a name sends a file to be
 * probed, and the probe is what catalogues it.
 */
describe('a withdrawn file a names-only listing offers again', () => {
  const named = (path: string): CatalogFile => file(path, { size: null, etag: null });

  beforeEach(async () => {
    await putFiles(db, [file('d/a.zip')], DIRECTORY);
  });

  it('is asked about again', async () => {
    await putFiles(db, [named('d/a.zip'), named('d/b.zip')], DIRECTORY);

    expect(existence('d/b.zip')).toBe('absent');
    expect(countUnsettled(db, 1)).toBe(1);
  });

  it('comes back when the probe finds it, counted as a file once more', async () => {
    await putFiles(db, [named('d/a.zip'), named('d/b.zip')], DIRECTORY);

    expect(partition()).toMatchObject({ files: 1, withdrawn: 1 });

    settleFiles(db, [{ venueId: 1, path: 'd/b.zip', size: 10, etag: 'e', modified: null, seenAt: 'T3' }]);

    expect(existence('d/b.zip')).toBe('confirmed');
    expect(partition()).toMatchObject({ files: 2, pending: 2, withdrawn: 0 });
    expect(logged().at(-1)).toMatchObject({ event: 'returned', cause: 'probe', path: 'd/b.zip' });
  });

  /** What the archives hold of it still counts, where the bytes are the ones it had. */
  it('keeps its download where it comes back as the same file, and not where it changed', async () => {
    db.exec(`UPDATE file SET downloaded_at = 'T2' WHERE path = 'd/b.zip'`);

    await putFiles(db, [named('d/a.zip'), named('d/b.zip')], DIRECTORY);
    settleFiles(db, [{ venueId: 1, path: 'd/b.zip', size: 10, etag: 'e', modified: null, seenAt: 'T3' }]);

    const at = (): string | null =>
      (db.prepare(`SELECT downloaded_at AS at FROM file WHERE path = 'd/b.zip'`).get() as { at: string | null }).at;

    expect(at()).toBe('T2');

    await putFiles(db, [file('d/a.zip')], DIRECTORY);
    await putFiles(db, [named('d/a.zip'), named('d/b.zip')], DIRECTORY);
    settleFiles(db, [{ venueId: 1, path: 'd/b.zip', size: 11, etag: 'f', modified: null, seenAt: 'T4' }]);

    expect(at()).toBeNull();
  });

  it('leaves a file that was never withdrawn exactly as it is', async () => {
    await putFiles(db, [named('d/a.zip')], DIRECTORY);

    expect(countUnsettled(db, 1)).toBe(0);
    expect(existence('d/a.zip')).toBe('confirmed');
  });
});
