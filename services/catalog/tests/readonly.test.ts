import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openScratch, putVenue } from './fixture';
import { openCatalog } from '../src/database';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Prospector is the only writer of the catalog database. This service is held
 * to that by the connection it opens, and not by what its code happens to do.
 *
 * The catalog is opened as prospector leaves it: in write-ahead-log mode, with
 * prospector's own connection open and writing.
 */

let dir:    string;
let writer: DatabaseSync;
let db:     DatabaseSync;

beforeEach(async () => {
  dir    = mkdtempSync(join(tmpdir(), 'catalog-readonly-'));
  writer = openScratch(join(dir, 'catalog.db'));

  putVenue(writer, 'gate', 'https://x');

  db = await openCatalog(join(dir, 'catalog.db'));
});

afterEach(() => {
  db.close();
  if (writer.isOpen) writer.close();
  rmSync(dir, { recursive: true, force: true });
});

const venues = (): unknown[] => db.prepare('SELECT name FROM venue ORDER BY name').all();

describe('the catalog service\'s connection', () => {
  it('reads a catalog in write-ahead-log mode', () => {
    expect(writer.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(venues()).toEqual([{ name: 'gate' }]);
  });

  it('sees what the writer commits while both are open', () => {
    putVenue(writer, 'binance', 'https://y');

    expect(venues()).toEqual([{ name: 'binance' }, { name: 'gate' }]);
  });

  it('lets the writer commit during a read, which keeps its snapshot', () => {
    const read = db.prepare('SELECT name FROM venue ORDER BY name').iterate();

    expect(read.next().value).toEqual({ name: 'gate' });

    putVenue(writer, 'binance', 'https://y');

    expect(read.next().done).toBe(true);
    expect(venues()).toEqual([{ name: 'binance' }, { name: 'gate' }]);
  });

  it('reads once the writer has closed', async () => {
    writer.close();
    db.close();

    db = await openCatalog(join(dir, 'catalog.db'));

    expect(venues()).toEqual([{ name: 'gate' }]);
  });

  it('refuses every write, whatever asks for it', () => {
    expect(() => db.prepare(`INSERT INTO venue (name, host, base, key_root) VALUES ('x', '', '', '')`).run())
      .toThrow(/readonly/);
    expect(() => db.prepare(`UPDATE lens SET note = 'x'`).run()).toThrow(/readonly/);
    expect(() => db.prepare('DELETE FROM lens_member').run()).toThrow(/readonly/);
    expect(() => db.exec('CREATE TABLE anything (id INTEGER)')).toThrow(/readonly/);
  });

  it('waits a short while on a lock rather than failing at once', () => {
    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 2000 });
  });
});
