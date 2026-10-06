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
 */

let dir: string;
let db:  DatabaseSync;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'catalog-readonly-'));

  const made = openScratch(join(dir, 'catalog.db'));

  putVenue(made, 'gate', 'https://x');
  made.close();

  db = await openCatalog(join(dir, 'catalog.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the catalog service\'s connection', () => {
  it('reads', () => {
    expect(db.prepare('SELECT name FROM venue').all()).toEqual([{ name: 'gate' }]);
  });

  it('refuses every write, whatever asks for it', () => {
    expect(() => db.prepare(`INSERT INTO venue (name, host, base, key_root) VALUES ('x', '', '', '')`).run())
      .toThrow(/readonly/);
    expect(() => db.prepare(`UPDATE lens SET note = 'x'`).run()).toThrow(/readonly/);
    expect(() => db.prepare('DELETE FROM lens_member').run()).toThrow(/readonly/);
    expect(() => db.exec('CREATE TABLE anything (id INTEGER)')).toThrow(/readonly/);
  });
});
