import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as record from '../../../src/tools/cold/shared/record';
import { DatabaseSync } from 'node:sqlite';
import type { CatalogPartition } from '../../../src/tools/cold/shared/types';

let dir: string;
let db:  DatabaseSync;

const partition = (dataset: string, over: Partial<CatalogPartition> = {}): CatalogPartition => ({
  venue: 'gate', market: 'spot', dataset, variant: '', grain: 'daily', bundle: 'instrument',
  month: '202001', files: 3, bytes: 30, version: 'v1', ...over,
});

const name = (seq: number) => ({ remote: `gate/2020/gate-202001.00${seq}.tar`, local: `gate/gate-202001.00${seq}.tar` });

const plan = (...partitions: CatalogPartition[]): number =>
  record.planTar(db, 'archives', 'gate', '202001', name, partitions);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-record-'));
  db  = record.open(path.join(dir, 'cold.sqlite'));
});

afterEach(() => {
  record.close(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('planning a tar', () => {
  it('records the tar and the partitions it will hold, at their versions', () => {
    const id = plan(partition('trades'), partition('klines', { version: 'k1' }));

    expect(record.tarById(db, id)).toMatchObject({ state: 'planned', seq: 1, remote: 'gate/2020/gate-202001.001.tar', bytes: null });
    expect(record.heldIn(db, id).map(one => `${one.dataset} ${one.version}`)).toEqual(['klines k1', 'trades v1']);
  });

  /** A month gains tars as more of it is stored; none is ever renumbered. */
  it('numbers a later tar of the same venue-month after the last', () => {
    plan(partition('trades'));

    expect(record.tarById(db, plan(partition('klines')))).toMatchObject({ seq: 2, local: 'gate/gate-202001.002.tar' });
  });

  it('refuses a partition a second tar would also hold', () => {
    plan(partition('trades'));

    expect(() => plan(partition('trades'))).toThrow();
    expect(record.tarsOf(db, 'archives')).toHaveLength(1);
  });
});

describe('a partition that changed in the catalog', () => {
  /** Nothing is packed yet, so the plan is dropped and drawn again from the catalog. */
  it('has its tar forgotten where that does not exist yet, and no other', () => {
    const made = plan(partition('klines'));

    record.packed(db, made, 1000);

    const id = plan(partition('trades'));

    expect(record.dropPlanned(db, 'archives', 'gate')).toBe(1);
    expect(record.heldIn(db, id)).toEqual([]);
    expect(record.tarsOf(db, 'archives').map(tar => tar.id)).toEqual([made]);
    expect(record.heldIn(db, made)).toHaveLength(1);
  });

  it('makes a stored tar one to bring back, and keeps what it holds on record until it is corrected', () => {
    const id = plan(partition('trades'), partition('klines'));

    record.packed(db, id, 1000);
    record.stored(db, id, 'H:old');
    record.noteChange(db, record.heldIn(db, id).find(one => one.dataset === 'trades')!, partition('trades', { version: 'v2', files: 4, bytes: 40 }));

    expect(record.tarById(db, id)).toMatchObject({ state: 'stale', handle: 'H:old' });
    expect(record.heldIn(db, id).find(one => one.dataset === 'trades'))
      .toMatchObject({ version: 'v1', next: { version: 'v2', files: 4, bytes: 40 } });
    expect(record.heldIn(db, id).find(one => one.dataset === 'klines')!.next).toBeNull();
  });

  it('holds the new version once the corrected tar is confirmed', () => {
    const id = plan(partition('trades'));

    record.packed(db, id, 1000);
    expect(record.confirmed(db, id, 'H:old')).toBe('stored');

    record.noteChange(db, record.heldIn(db, id)[0]!, partition('trades', { version: 'v2', files: 4, bytes: 40 }));

    // Brought back and corrected to what was noted.
    record.packed(db, id, 1200, [{ ...record.heldIn(db, id)[0]!, version: 'v2', files: 4, bytes: 40 }]);

    expect(record.heldIn(db, id)[0]).toMatchObject({ version: 'v1', packed: { version: 'v2', files: 4, bytes: 40 } });
    expect(record.confirmed(db, id, 'H:new')).toBe('stored');
    expect(record.heldIn(db, id)[0]).toMatchObject({ version: 'v2', files: 4, bytes: 40, next: null, packed: null });
    expect(record.tarById(db, id)).toMatchObject({ state: 'stored', handle: 'H:new' });
  });

  /** A tar on its way holds what it was made with, whatever the catalog says since. */
  it('holds what a tar was packed with once it is confirmed, and leaves it to be corrected where the catalog moved on', () => {
    const id = plan(partition('trades'), partition('klines'));

    record.packed(db, id, 1000);
    record.noteChange(db, record.heldIn(db, id).find(one => one.dataset === 'trades')!, partition('trades', { version: 'v2', files: 4, bytes: 40 }));

    expect(record.tarById(db, id).state).toBe('packed');
    expect(record.confirmed(db, id, 'H:1')).toBe('stale');
    expect(record.heldIn(db, id).find(one => one.dataset === 'trades'))
      .toMatchObject({ version: 'v1', files: 3, next: { version: 'v2', files: 4, bytes: 40 }, packed: null });
    expect(record.tarById(db, id)).toMatchObject({ state: 'stale', handle: 'H:1' });
    expect(record.storedOf(db, 'archives', 'gate')).toEqual([]);
  });

  it('takes back a change of a tar not brought back yet, once the catalog is back to what is stored', () => {
    const id = plan(partition('trades'));

    record.packed(db, id, 1000);
    record.confirmed(db, id, 'H:1');
    record.noteChange(db, record.heldIn(db, id)[0]!, partition('trades', { version: 'v2' }));

    expect(record.cancelChange(db, record.heldIn(db, id)[0]!)).toBe(true);
    expect(record.heldIn(db, id)[0]).toMatchObject({ version: 'v1', next: null });
    expect(record.tarById(db, id)).toMatchObject({ state: 'stored', handle: 'H:1' });
  });

  it('does not take back a change of a tar already being brought back', () => {
    const id = plan(partition('trades'));

    record.packed(db, id, 1000);
    record.confirmed(db, id, 'H:1');
    record.noteChange(db, record.heldIn(db, id)[0]!, partition('trades', { version: 'v2' }));
    record.move(db, id, 'fetching');

    expect(record.cancelChange(db, record.heldIn(db, id)[0]!)).toBe(false);
    expect(record.heldIn(db, id)[0]!.next).toMatchObject({ version: 'v2' });
  });
});

describe('a tar Mega has held', () => {
  /** Sent back to be packed again, it is still the record's only map of what is in it. */
  it('is not dropped with the plans', () => {
    const id = plan(partition('trades'));

    record.packed(db, id, 1000);
    record.confirmed(db, id, 'H:1');
    record.move(db, id, 'planned');

    expect(record.dropPlanned(db, 'archives', 'gate')).toBe(0);
    expect(record.heldIn(db, id)).toHaveLength(1);
  });
});

describe('a record whose held table has no columns for what a tar was packed with', () => {
  it('gains the columns, empty, and keeps what it holds', () => {
    const file = path.join(dir, 'old.sqlite');
    const old  = new DatabaseSync(file);

    old.exec(`CREATE TABLE held (
      tar_id INTEGER NOT NULL, origin TEXT NOT NULL, venue TEXT NOT NULL, market TEXT NOT NULL, dataset TEXT NOT NULL,
      variant TEXT NOT NULL, grain TEXT NOT NULL, bundle TEXT NOT NULL, month TEXT NOT NULL, version TEXT NOT NULL,
      files INTEGER NOT NULL, bytes INTEGER NOT NULL, next_version TEXT, next_files INTEGER, next_bytes INTEGER,
      PRIMARY KEY (origin, venue, market, dataset, variant, grain, bundle, month)) STRICT`);
    old.exec(`INSERT INTO held VALUES (7, 'archives', 'gate', 'spot', 'trades', '', 'daily', 'instrument', '202001', 'v1', 3, 30, NULL, NULL, NULL)`);
    old.close();

    const opened = record.open(file);

    try {
      expect(record.heldIn(opened, 7)).toEqual([expect.objectContaining({ version: 'v1', next: null, packed: null })]);

      // Opened again, nothing is added twice.
      record.close(opened);
      record.close(record.open(file));
    } finally {
      record.close(opened);
    }
  });

  /** Commands run side by side: every one that opens the record at once finds it as it should be. */
  it('gains them once where several commands open it at the same moment', async () => {
    const file = path.join(dir, 'old.sqlite');
    const old  = new DatabaseSync(file);

    old.exec('PRAGMA journal_mode = WAL');
    old.exec(`CREATE TABLE held (
      tar_id INTEGER NOT NULL, origin TEXT NOT NULL, venue TEXT NOT NULL, market TEXT NOT NULL, dataset TEXT NOT NULL,
      variant TEXT NOT NULL, grain TEXT NOT NULL, bundle TEXT NOT NULL, month TEXT NOT NULL, version TEXT NOT NULL,
      files INTEGER NOT NULL, bytes INTEGER NOT NULL, next_version TEXT, next_files INTEGER, next_bytes INTEGER,
      PRIMARY KEY (origin, venue, market, dataset, variant, grain, bundle, month)) STRICT`);
    old.close();

    const schema = pathToFileURL(path.resolve(__dirname, '../../../src/tools/cold/shared/record/schema.ts')).href;
    const start  = Date.now() + 1_500;

    // Each waits for the same moment, then opens the record.
    const code = `import { open, close } from ${JSON.stringify(schema)};
      while (Date.now() < ${start});
      close(open(${JSON.stringify(file)}));`;

    const exits = await Promise.all(Array.from({ length: 6 }, () => new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', code]);
      let stderr  = '';

      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('close', exit => resolve({ code: exit, stderr }));
    })));

    expect(exits).toEqual(Array.from({ length: 6 }, () => ({ code: 0, stderr: '' })));
  }, 20_000);
});

describe('what the record holds', () => {
  it('adds up tars, what is stored, and the partitions', () => {
    const one = plan(partition('trades'), partition('klines'));

    plan(partition('funding'));
    record.packed(db, one, 500);
    record.stored(db, one, 'H:1');

    expect(record.totals(db, 'archives')).toEqual({ tars: 2, stored: 1, bytes: 500, storedBytes: 500, partitions: 3 });
  });
});

describe('a partition a pull brought back', () => {
  const key = { ...partition('trades'), version: 'v1' };

  it('is written down as back on disk and as pulled', () => {
    record.noteEviction(db, 'archives', key, { files: 3, bytes: 30 });
    record.noteBack(db, 'archives', key);

    expect(record.evictedOf(db, 'archives', 'gate').size).toBe(0);
    expect([...record.pulledOf(db, 'archives', 'gate')]).toHaveLength(1);
  });

  it('is never written down as back without being written down as pulled', () => {
    record.noteEviction(db, 'archives', key, { files: 3, bytes: 30 });
    db.exec(`CREATE TRIGGER refuse BEFORE INSERT ON pulled BEGIN SELECT RAISE(ABORT, 'refused'); END`);

    expect(() => record.noteBack(db, 'archives', key)).toThrow(/refused/);
    expect(record.evictedOf(db, 'archives', 'gate').size).toBe(1);
    expect(record.pulledOf(db, 'archives', 'gate').size).toBe(0);
  });
});
