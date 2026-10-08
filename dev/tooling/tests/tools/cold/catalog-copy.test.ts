import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _test_apply as apply, _test_fetch as fetch, _test_isSnapshot as isSnapshot, _test_targetOf as targetOf } from '../../../src/tools/cold/pull/catalog';
import {
  _test_copySnapshot as copySnapshot, _test_deliver as deliver, _test_storeSnapshot as storeSnapshot, _test_whole as whole,
  _test_writePartitions as writePartitions, clearStale, settleSnapshot,
} from '../../../src/tools/cold/push/catalog';
import { snapshotOf } from '../../../src/tools/cold/cli';
import { setYes } from '../../../src/tools/cold/options';
import { fileSchemaOf, openCatalog, partitionsOf, tablesOf, writePartition, writeTables } from '../../../src/tools/cold/push/catalog/source';
import * as record from '../../../src/tools/cold/shared/record';
import type { Sending } from '../../../src/tools/cold/push/types';
import type { Fetching, Remote } from '../../../src/tools/cold/shared/types';
import type { ColdConfig } from '../../../src/tools/cold/types';

/**
 * The catalog's copy in cold storage: the database as the base, a file for
 * each partition that changed since, every other table as one small database
 * every time — and the database put back together from them.
 */

let dir: string;
let db:  DatabaseSync;
let sent: string[];

const config = (): ColdConfig => ({
  sourceRoot: path.join(dir, 'archives'), vaultRoot: path.join(dir, 'vault'), coldRoot: path.join(dir, 'cold'), megaRoot: '/x', backupRoot: '/x/@cold',
  catalogDb: path.join(dir, 'catalog', 'catalog.db'), catalogRoot: '/x/@catalog',
  dbPath: path.join(dir, 'cold.sqlite'), capBytes: 1e12, queueTargetGb: 10, settledHours: null, catalogUrl: 'http://catalog.test', catalogToken: '',
});

const inMega = (at = ''): string => path.join(dir, 'mega', at);

/** Mega, as a directory: what is handed over is there at once, and what is asked for comes back at once. */
const remote = (): Remote & Fetching => {
  const take = (local: string, remoteDir: string): void => {
    const at = path.posix.join(path.posix.relative('/x/@catalog', remoteDir), path.basename(local));

    sent.push(at);

    fs.mkdirSync(path.dirname(inMega(at)), { recursive: true });
    fs.copyFileSync(local, inMega(at));
  };

  const below = (root: string): Map<string, { bytes: number; handle: string | null }> => {
    const from  = inMega(path.posix.relative('/x/@catalog', root));
    const found = new Map<string, { bytes: number; handle: string | null }>();

    const walk = (at: string): void => {
      for (const entry of fs.existsSync(at) ? fs.readdirSync(at, { withFileTypes: true }) : []) {
        if (entry.isDirectory()) walk(path.join(at, entry.name));
        else found.set(path.relative(from, path.join(at, entry.name)), { bytes: fs.statSync(path.join(at, entry.name)).size, handle: 'H' });
      }
    };

    walk(from);

    return found;
  };

  return {
    queuedPaths:      async () => new Set<string>(),
    queue:            async () => ({ remaining: 0, total: 0, uploaded: 0, transfers: 0 }),
    listing:          async root => below(root),
    remove:           async () => {},
    removeTree:       async (at) => { fs.rmSync(inMega(path.posix.relative('/x/@catalog', at)), { recursive: true, force: true }); },
    queueUpload:      async (local, remoteDir) => take(local, remoteDir),
    queueUploads:     async (locals, remoteDir) => { for (const local of locals) take(local, remoteDir); },
    downloadingPaths: async () => new Set<string>(),
    queueDownload:    async (from, into) => { fs.copyFileSync(inMega(path.posix.relative('/x/@catalog', from)), path.join(into, path.basename(from))); },
  };
};

/** A catalog of one slice and two partitions, as the real one declares what a copy reads. */
const build = (): void => {
  fs.mkdirSync(path.dirname(config().catalogDb), { recursive: true });

  const catalog = new DatabaseSync(config().catalogDb);

  catalog.exec(`
    CREATE TABLE slice (id INTEGER PRIMARY KEY, venue TEXT NOT NULL, market TEXT NOT NULL, dataset TEXT NOT NULL, variant TEXT NOT NULL DEFAULT '',
                        grain TEXT NOT NULL, bundle TEXT NOT NULL) STRICT;
    CREATE TABLE partition (id INTEGER PRIMARY KEY, slice_id INTEGER NOT NULL REFERENCES slice (id), month TEXT NOT NULL, version TEXT NOT NULL, note TEXT) STRICT;
    CREATE TABLE file (venue_id INTEGER NOT NULL, path TEXT NOT NULL, date TEXT NOT NULL, size INTEGER, etag TEXT, modified TEXT,
                       series_id INTEGER NOT NULL, partition_id INTEGER NOT NULL, existence TEXT NOT NULL, seen_at TEXT NOT NULL,
                       downloaded_at TEXT, PRIMARY KEY (venue_id, path)) STRICT;
    CREATE INDEX file_partition ON file (partition_id);
    CREATE TABLE wip (id INTEGER PRIMARY KEY, note TEXT) STRICT;
    CREATE INDEX wip_note ON wip (note);
    CREATE TABLE run (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT) STRICT;
    CREATE INDEX partition_month ON partition (month);
    CREATE TRIGGER partition_noted AFTER INSERT ON partition BEGIN UPDATE partition SET note = 'by the trigger' WHERE id = NEW.id; END;
    INSERT INTO run (note) VALUES ('one'), ('two');
    DELETE FROM run WHERE id = 2;
    CREATE TABLE lens_member (lens_id INTEGER NOT NULL, partition_id INTEGER NOT NULL, PRIMARY KEY (lens_id, partition_id)) STRICT, WITHOUT ROWID;
    INSERT INTO lens_member VALUES (2, 1), (1, 2), (1, 1);
    INSERT INTO wip VALUES (1, 'half done');
    INSERT INTO slice VALUES (1, 'gate', 'spot', 'klines', '1h', 'daily', 'instrument'), (2, 'gate', 'spot', 'trades', '', 'daily', 'instrument');
    INSERT INTO partition VALUES (1, 1, '202001', 'v1', NULL), (2, 1, '202002', 'v1', NULL);
    UPDATE partition SET note = NULL;
    INSERT INTO file VALUES (1, 'b,with a comma.gz', '20200102', 20, 'e2', 'T', 7, 1, 'confirmed', 'T', NULL),
                            (1, 'a.gz', '20200101', 10, 'e1', 'T', 7, 1, 'confirmed', 'T', 'D1'),
                            (1, 'c.gz', '20200201', 30, 'e3', 'T', 7, 2, 'confirmed', 'T', 'D3');
  `);
  catalog.close();
};

const change = (sql: string): void => {
  const catalog = new DatabaseSync(config().catalogDb);

  catalog.exec(sql);
  catalog.close();
};

/** What a push does once it has decided what there is to send. */
const push = async (rebase = false): Promise<void> => {
  const catalog = openCatalog(config().catalogDb);
  const state: Sending = { db, config: config(), catalog, remote: remote(), staging: path.join(dir, 'cold', 'catalog'), writing: async () => false };

  try {
    const partitions = partitionsOf(catalog);
    const copies     = record.catalogCopies(db);
    const basing     = rebase || copies.get('catalog.db')?.state !== 'stored';

    if (basing) await copySnapshot(state, partitions);

    writeTables(catalog, path.join(state.staging, 'tables.db'));
    await writePartitions(state, basing ? [] : partitions.filter(one => copies.get(one.name)?.version !== one.version));

    if (basing) await storeSnapshot(db, config(), state.staging, state.remote, rebase, 1);

    await deliver(db, config(), state.staging, state.remote, 1);
  } finally {
    catalog.close();
  }
};

beforeEach(() => {
  dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-catalog-'));
  db   = record.open(path.join(dir, 'cold.sqlite'));
  sent = [];

  build();
});

afterEach(() => {
  record.close(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a part of the catalog, written to a file', () => {
  it('is a partition\'s file rows by path, without which partition they are of or whether they were downloaded', async () => {
    const catalog = openCatalog(config().catalogDb);
    const [first] = partitionsOf(catalog);
    const file    = path.join(dir, 'p.gz');

    await writePartition(catalog, first!.id, file);
    catalog.close();

    expect(first!.name).toBe('gate|spot|klines,1h|daily|instrument|202001');
    expect(gunzipSync(fs.readFileSync(file)).toString()).toBe([
      'venue_id,path,date,size,etag,modified,series_id,existence,seen_at',
      '1,a.gz,20200101,10,e1,T,7,confirmed,T',
      '1,"b,with a comma.gz",20200102,20,e2,T,7,confirmed,T',
      '',
    ].join('\n'));
  });

  it('is every table but the files and what is only work in progress', () => {
    const catalog = openCatalog(config().catalogDb);

    expect(tablesOf(catalog)).toEqual(['lens_member', 'partition', 'run', 'slice']);

    catalog.close();
  });
});

describe('everything but the file rows, as one database', () => {
  const written = (): DatabaseSync => {
    const catalog = openCatalog(config().catalogDb);

    writeTables(catalog, path.join(dir, 'tables.db'));
    catalog.close();

    return new DatabaseSync(path.join(dir, 'tables.db'));
  };

  const declared = (from: DatabaseSync): unknown[] =>
    from.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`).all();

  it('declares everything the catalog declares: tables, indexes and triggers, the files\' and the work in progress too', () => {
    const tables  = written();
    const catalog = openCatalog(config().catalogDb);

    expect(declared(tables)).toEqual(declared(catalog));
    expect(fileSchemaOf(tables)).toBe(fileSchemaOf(catalog));

    tables.close();
    catalog.close();
  });

  /** Rows as they are — a trigger declared before they went in would have rewritten them. */
  it('holds the rows of every table but those two, as they are', () => {
    const tables = written();

    expect(tables.prepare('SELECT count(*) AS n FROM file').get()).toEqual({ n: 0 });
    expect(tables.prepare('SELECT count(*) AS n FROM wip').get()).toEqual({ n: 0 });
    expect(tables.prepare('SELECT * FROM lens_member').all()).toEqual([{ lens_id: 1, partition_id: 1 }, { lens_id: 1, partition_id: 2 }, { lens_id: 2, partition_id: 1 }]);
    expect(tables.prepare('SELECT id, version, note FROM partition ORDER BY id').all()).toEqual([{ id: 1, version: 'v1', note: null }, { id: 2, version: 'v1', note: null }]);
    expect(tables.prepare('SELECT variant FROM slice WHERE id = 2').get()).toEqual({ variant: '' });

    // The next number the catalog would give a row is the catalog's, not one more than what is left.
    expect(tables.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'run'`).get()).toEqual({ seq: 2 });

    tables.close();
  });

  /** What ties a snapshot to what is sent after it: the files' table and its indexes, and nothing else. */
  it('tells a files\' table declared otherwise, and not a change to any other table', () => {
    const before = (): string => { const catalog = openCatalog(config().catalogDb); const schema = fileSchemaOf(catalog); catalog.close(); return schema; };
    const was    = before();

    change('ALTER TABLE slice ADD COLUMN extra TEXT; CREATE INDEX slice_venue ON slice (venue)');
    expect(before()).toBe(was);

    change('CREATE INDEX file_when ON file (venue_id, date)');
    expect(before()).not.toBe(was);
  });
});

describe('the catalog made one file', () => {
  it('has its write-ahead log folded in, and the log gone', async () => {
    const catalog = new DatabaseSync(config().catalogDb);

    catalog.exec('PRAGMA journal_mode = WAL');
    catalog.exec('PRAGMA wal_autocheckpoint = 0');
    catalog.exec(`UPDATE partition SET note = 'in the log'`);

    // Left as a connection that did not close last leaves it: the log beside the database.
    fs.copyFileSync(`${config().catalogDb}-wal`, `${config().catalogDb}-wal.kept`);
    catalog.close();
    fs.renameSync(`${config().catalogDb}-wal.kept`, `${config().catalogDb}-wal`);

    expect(fs.existsSync(`${config().catalogDb}-wal`)).toBe(true);

    await whole(config().catalogDb);

    expect(fs.existsSync(`${config().catalogDb}-wal`)).toBe(false);
    expect(fs.existsSync(`${config().catalogDb}-shm`)).toBe(false);
  }, 20_000);

  /** A log that will not go is somebody with the database open. */
  it('is refused where the log is still there afterwards', async () => {
    const holder = new DatabaseSync(config().catalogDb);

    holder.exec('PRAGMA journal_mode = WAL');
    holder.exec(`UPDATE partition SET note = 'held'`);

    await expect(whole(config().catalogDb)).rejects.toThrow(/something else has it open/);

    holder.close();
  }, 20_000);
});

describe('the catalog\'s copy', () => {
  it('is the catalog as it was sent, with its tables beside it and no partition of its own, the first time', async () => {
    await push();

    expect(sent.sort()).toEqual(['catalog.db', 'tables.db']);
    expect(fs.readFileSync(inMega('catalog.db')).equals(fs.readFileSync(config().catalogDb))).toBe(true);

    // Every partition is written down as the base has it.
    expect([...record.catalogCopies(db).values()].filter(one => one.kind === 'partition').map(one => `${one.version} ${one.state} ${one.remote}`))
      .toEqual(['v1 stored ', 'v1 stored ']);

    // And how the files' table was declared as the snapshot was taken.
    expect(record.catalogCopies(db).get('catalog.db')!.schema).toMatch(/^CREATE INDEX file_partition ON file \(partition_id\);\nCREATE TABLE file /);
  });

  it('is only the tables the next time, where no partition changed', async () => {
    await push();
    sent = [];

    await push();

    expect(sent.sort()).toEqual(['tables.db']);
  });

  /** A partition goes when the catalog's version of it moves — and is one file however often that is. */
  it('is the partition that changed, at the one place it has', async () => {
    await push();

    change(`INSERT INTO file VALUES (1, 'd.gz', '20200202', 40, 'e4', 'T', 7, 2, 'confirmed', 'T', NULL); UPDATE partition SET version = 'v2' WHERE id = 2`);
    await push();

    change(`UPDATE partition SET version = 'v3' WHERE id = 2`);
    sent = [];
    await push();

    expect(sent.filter(one => one.startsWith('partitions/'))).toEqual(['partitions/gate/2020/gate|spot|klines,1h|daily|instrument|202002.csv.gz']);
    expect(fs.readdirSync(inMega('partitions/gate/2020'))).toHaveLength(1);
  });

  it('is the database again where a new base is asked for, and no partition\'s file is left from before', async () => {
    await push();

    change(`UPDATE partition SET version = 'v2' WHERE id = 2`);
    await push();

    sent = [];
    await push(true);

    expect(sent).toContain('catalog.db');
    expect(fs.existsSync(inMega('partitions'))).toBe(false);
    expect([...record.catalogCopies(db).values()].filter(one => one.kind === 'partition').map(one => one.version).sort()).toEqual(['v1', 'v2']);
  });
});

describe('the catalog brought back', () => {
  const pulled = (): ColdConfig => config();

  /** Push, change, push again; then bring it back and put it together. */
  const restore = async (): Promise<DatabaseSync> => {
    const wanted = new Map((await remote().listing('/x/@catalog')).entries());

    await fetch(pulled(), wanted, remote(), 1);

    const base = path.join(dir, 'cold', 'pulling', 'catalog', 'catalog.db');

    await apply(base, path.join(path.dirname(base), 'tables.db'), path.join(path.dirname(base), 'partitions'));

    return new DatabaseSync(base);
  };

  it('is the base where nothing changed since', async () => {
    await push();

    const back = await restore();

    expect(back.prepare('SELECT count(*) AS n FROM file').get()).toEqual({ n: 3 });
    expect(back.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'file_partition'`).get()).toBeTruthy();

    back.close();
  });

  it('has what changed since put into it: the tables whole, and the changed partition\'s file rows', async () => {
    await push();

    change(`
      INSERT INTO file VALUES (1, 'd.gz', '20200202', 40, 'e4', 'T', 7, 2, 'confirmed', 'T', NULL);
      UPDATE file SET etag = 'e3b', size = 31 WHERE path = 'c.gz';
      UPDATE partition SET version = 'v2', note = 'changed' WHERE id = 2;
      INSERT INTO slice VALUES (3, 'gate', 'perp', 'trades', '', 'daily', 'instrument');
    `);
    await push();

    const back = await restore();

    expect(back.prepare('SELECT count(*) AS n FROM slice').get()).toEqual({ n: 3 });
    expect(back.prepare('SELECT version, note FROM partition ORDER BY id').all()).toEqual([{ version: 'v1', note: null }, { version: 'v2', note: 'changed' }]);
    expect(back.prepare('SELECT variant FROM slice WHERE id = 2').get()).toEqual({ variant: '' });
    expect(back.prepare('SELECT path, size, etag FROM file WHERE partition_id = 2 ORDER BY path').all())
      .toEqual([{ path: 'c.gz', size: 31, etag: 'e3b' }, { path: 'd.gz', size: 40, etag: 'e4' }]);

    back.close();
  });

  /** Every table but the files' is as it was sent last, schema and all; the files' table and its indexes are the snapshot's. */
  it('has the schema the catalog had when it was last sent, whatever the snapshot had', async () => {
    await push();

    change(`
      ALTER TABLE slice ADD COLUMN extra TEXT;
      UPDATE slice SET extra = 'new' WHERE id = 1;
      CREATE INDEX slice_venue ON slice (venue);
      DROP TRIGGER partition_noted;
      CREATE TABLE added (id INTEGER PRIMARY KEY, what TEXT) STRICT;
      INSERT INTO added VALUES (1, 'since the snapshot');
      INSERT INTO run (note) VALUES ('three');
    `);
    await push();

    const back    = await restore();
    const catalog = openCatalog(config().catalogDb);
    const declared = (from: DatabaseSync): unknown[] =>
      from.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`).all();

    expect(declared(back)).toEqual(declared(catalog));
    expect(back.prepare('SELECT extra FROM slice ORDER BY id').all()).toEqual([{ extra: 'new' }, { extra: null }]);
    expect(back.prepare('SELECT * FROM added').all()).toEqual([{ id: 1, what: 'since the snapshot' }]);
    expect(back.prepare('SELECT count(*) AS n FROM wip').get()).toEqual({ n: 0 });
    expect(back.prepare('SELECT count(*) AS n FROM file').get()).toEqual({ n: 3 });
    expect(back.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'run'`).get()).toEqual({ seq: 3 });
    expect(back.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });

    back.close();
    catalog.close();
  });

  /** What is sent after a snapshot goes into its table of files: one declared otherwise cannot take it. */
  it('is refused where the snapshot\'s table of files is not the one the tables were sent with', async () => {
    await push();

    change('CREATE INDEX file_when ON file (venue_id, date)');
    await push();

    await expect(restore()).rejects.toThrow(/table of files is not declared/);
  });

  /** A file row that is there is written over, one that is not is added, and none is taken out. */
  it('puts a partition\'s rows into the files\' table without taking any out', async () => {
    await push();

    // A file that has moved to another partition since: it is the same row, in its new place.
    change(`UPDATE file SET partition_id = 2 WHERE path = 'a.gz'; UPDATE partition SET version = 'v2' WHERE id = 2`);
    await push();

    const back = await restore();

    expect(back.prepare('SELECT path, partition_id, downloaded_at FROM file ORDER BY path').all()).toEqual([
      { path: 'a.gz', partition_id: 2, downloaded_at: 'D1' },
      { path: 'b,with a comma.gz', partition_id: 1, downloaded_at: null },
      { path: 'c.gz', partition_id: 2, downloaded_at: 'D3' },
    ]);

    back.close();
  });

  /** The same file as the base had keeps what the base said of it; a changed or a new one was not downloaded, as far as the copy knows. */
  it('keeps whether a file was downloaded where it is the file the base had', async () => {
    await push();

    change(`
      INSERT INTO file VALUES (1, 'aa.gz', '20200103', 5, 'e5', 'T', 7, 1, 'confirmed', 'T', NULL);
      UPDATE partition SET version = 'v2' WHERE id = 1;
      UPDATE file SET etag = 'e3b' WHERE path = 'c.gz';
      UPDATE partition SET version = 'v2' WHERE id = 2;
    `);
    await push();

    const back = await restore();

    expect(back.prepare('SELECT path, downloaded_at FROM file ORDER BY path').all()).toEqual([
      { path: 'a.gz', downloaded_at: 'D1' },
      { path: 'aa.gz', downloaded_at: null },
      { path: 'b,with a comma.gz', downloaded_at: null },
      { path: 'c.gz', downloaded_at: null },
    ]);

    back.close();
  });

  /** What a push leaves in cold's working directory is the snapshot, and saves bringing it back. */
  it('tells the snapshot from any other file: by what Mega holds, what it weighs, and its digest', async () => {
    await push();

    const kept  = path.join(dir, 'cold', 'catalog', 'catalog.db');
    const known = record.catalogCopies(db).get('catalog.db')!;
    const held  = (await remote().listing('/x/@catalog')).get('catalog.db')!;

    expect(known).toMatchObject({ kind: 'base', state: 'stored', handle: 'H', bytes: fs.statSync(kept).size });
    expect(known.version).toMatch(/^[0-9a-f]{64}$/);
    expect(await isSnapshot(kept, held, known)).toBe(true);

    // Mega holds another object there now: what is here is no longer known to be what it holds.
    expect(await isSnapshot(kept, { ...held, handle: 'OTHER' }, known)).toBe(false);
    expect(await isSnapshot(kept, held, null)).toBe(false);

    // The same size, and not the same file.
    const other = path.join(dir, 'other.db');
    const bytes = fs.readFileSync(kept);

    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    fs.writeFileSync(other, bytes);

    expect(await isSnapshot(other, held, known)).toBe(false);
  });

  /** A run that took one removes it unless told to keep it; a run that took none leaves what is there unless told to drop it. */
  it('removes the snapshot a push took unless told to keep it, and leaves alone one a push did not take unless told to drop it', () => {
    const file = path.join(dir, 'snapshot.db');
    const left = (taking: boolean, asked?: 'keep' | 'drop'): boolean => {
      fs.writeFileSync(file, 'x');
      settleSnapshot(file, taking, asked);

      return fs.existsSync(file);
    };

    expect(left(true)).toBe(false);
    expect(left(true, 'drop')).toBe(false);
    expect(left(true, 'keep')).toBe(true);

    expect(left(false)).toBe(true);
    expect(left(false, 'keep')).toBe(true);
    expect(left(false, 'drop')).toBe(false);

    // Nothing there: nothing to do, whatever was asked.
    fs.rmSync(file, { force: true });
    settleSnapshot(file, false, 'drop');
    settleSnapshot(file, false, 'keep');
    expect(fs.existsSync(file)).toBe(false);
  });

  /** Something where the snapshot is kept that is not it is as large as the catalog and of no use: said, and removed where agreed. */
  it('asks to delete what is found in the snapshot\'s place and is not it, and takes yes where every answer was given', async () => {
    const file = path.join(dir, 'snapshot.db');

    fs.writeFileSync(file, 'xx');

    // What it weighs is the snapshot's: nothing is asked.
    expect(await clearStale(file, 2)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);

    setYes(true);

    try {
      expect(await clearStale(file, 3)).toBe(true);
      expect(fs.existsSync(file)).toBe(false);
      expect(await clearStale(file, 3)).toBe(true);
    } finally {
      setYes(false);
    }
  });

  it('takes one of the two things the command line can say of the snapshot, and not both', () => {
    expect(snapshotOf({})).toEqual({});
    expect(snapshotOf({ keepSnapshot: true })).toEqual({ snapshot: 'keep' });
    expect(snapshotOf({ dropSnapshot: true })).toEqual({ snapshot: 'drop' });
    expect(() => snapshotOf({ keepSnapshot: true, dropSnapshot: true })).toThrow(/opposite/);
  });

  it('is left in cold\'s own directory unless told where, as catalog.db unless a file is named', () => {
    expect(targetOf(config(), undefined)).toBe(path.join(dir, 'cold', 'pulled', 'catalog', 'catalog.db'));
    expect(targetOf(config(), path.join(dir, 'elsewhere'))).toBe(path.join(dir, 'elsewhere', 'catalog.db'));
    expect(targetOf(config(), `${path.join(dir, 'elsewhere')}/`)).toBe(path.join(dir, 'elsewhere', 'catalog.db'));
    expect(targetOf(config(), path.join(dir, 'elsewhere', 'restored.db'))).toBe(path.join(dir, 'elsewhere', 'restored.db'));
  });
});
