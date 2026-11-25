import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG_SCHEMA, SCHEMA_VERSION, emptyCatalog } from '../src/testing';

const opened: DatabaseSync[] = [];
const dirs:   string[]       = [];

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const keep = (db: DatabaseSync): DatabaseSync => (opened.push(db), db);

/** Every table, index and trigger, by kind and name. */
const shape = (db: DatabaseSync): string[] =>
  (db.prepare(`SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`)
    .all() as { type: string; name: string }[]).map(({ type, name }) => `${type} ${name}`);

const tables = (db: DatabaseSync): string[] =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[]).map(({ name }) => name);

describe('emptyCatalog', () => {
  it('has the whole schema, at the current version', () => {
    const db = keep(emptyCatalog());

    const reference = keep(new DatabaseSync(':memory:'));
    reference.exec(CATALOG_SCHEMA);

    expect(shape(db)).toEqual(shape(reference));
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
  });

  it('holds no rows, shipped venues and exclusions included', () => {
    const db = keep(emptyCatalog());

    for (const table of tables(db))
      expect(db.prepare(`SELECT count(*) n FROM "${table}"`).get(), table).toEqual({ n: 0 });
  });

  it('enforces foreign keys and column types', () => {
    const db = keep(emptyCatalog());

    expect(() => db.prepare(`INSERT INTO partition (slice_id, month, updated_at) VALUES (99, '202501', 'now')`).run())
      .toThrow(/FOREIGN KEY/);
    expect(() => db.prepare(`INSERT INTO venue (name, base, key_root) VALUES ('v', 'b', 'k')`).run()).not.toThrow();
    expect(() => db.prepare(`UPDATE venue SET id = 'one'`).run()).toThrow(/INTEGER|datatype/);
  });

  it('writes a series its prefix, as the trigger does in a real catalog', () => {
    const db = keep(emptyCatalog());

    db.exec(`
      INSERT INTO venue (id, name, base, key_root) VALUES (1, 'v', 'b', '');
      INSERT INTO slice (id, venue, market, dataset, grain, bundle) VALUES (1, 'v', 'spot', 'trades', 'daily', 'instrument');
      INSERT INTO pattern (id, venue_id, slice_id, pattern) VALUES (1, 1, 1, '{SYMBOL}.zip');
      INSERT INTO instrument (id, venue, market, symbol) VALUES (1, 'v', 'spot', 'BTCUSDT');
      INSERT INTO series (pattern_id, instrument_id) VALUES (1, 1);
    `);

    expect(db.prepare('SELECT prefix FROM series').get()).toEqual({ prefix: 'v/spot/trades/B/BTCUSDT/' });
  });

  it('creates the file at a path it is given', () => {
    const dir  = mkdtempSync(join(tmpdir(), 'testing-'));
    const path = join(dir, 'catalog.db');
    dirs.push(dir);

    const db = keep(emptyCatalog(path));

    expect(existsSync(path)).toBe(true);
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(tables(db)).toContain('file');
  });
});
