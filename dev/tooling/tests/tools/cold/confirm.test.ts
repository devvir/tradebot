import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { confirmTars, confirmVault } from '../../../src/tools/cold/push/confirm';
import { _test_duplicatesIn as duplicatesIn } from '../../../src/tools/cold/shared/mega/transfers';
import * as record from '../../../src/tools/cold/shared/record';
import type { DatabaseSync } from 'node:sqlite';
import type { CatalogPartition, Remote, VaultFile } from '../../../src/tools/cold/shared/types';
import type { ColdConfig } from '../../../src/tools/cold/types';

/** The second look at what a push has just stored, and the queue kept free of second transfers of a file. */

let dir: string;
let db:  DatabaseSync;
let held: Map<string, { bytes: number; handle: string | null }>;

const config = (): ColdConfig => ({
  sourceRoot: path.join(dir, 'archives'), vaultRoot: path.join(dir, 'vault'), coldRoot: path.join(dir, 'cold'), megaRoot: '/x',
  backupRoot: '/x/cold', dbPath: path.join(dir, 'cold.sqlite'), capBytes: 1e12, queueTargetGb: 10, settledHours: null,
  catalogUrl: 'http://catalog.test', catalogToken: 't',
});

const remote = (): Remote => ({
  queuedPaths: async () => new Set<string>(),
  queue:       async () => ({ remaining: 0, total: 0, uploaded: 0, transfers: 0 }),
  listing:     async () => held,
  queueUpload: async () => {},
  remove:      async () => {},
});

const SLICE = 'venue=gate/market=spot/dataset=trades';

const stored = (month: string): VaultFile => {
  const file: VaultFile = { partition: `${SLICE}/${month}`, revision: 'r1', instrument: '@', side: '', path: `${SLICE}/@/${month}.parquet`, bytes: 10 };

  record.planVaultFiles(db, [file]);
  record.moveVaultFile(db, file, 'stored', 'FIRST');
  record.storeVaultPartition(db, file.partition, file.revision);

  held.set(`spot/trades/@/${month}.parquet`, { bytes: 10, handle: 'FIRST' });

  return file;
};

const LONG_AGO = '2000-01-01T00:00:00.000Z';

beforeEach(() => {
  dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-confirm-'));
  db   = record.open(path.join(dir, 'cold.sqlite'));
  held = new Map();
});

afterEach(() => {
  record.close(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a second look at vault files just stored', () => {
  it('leaves alone what is there as it was written down', async () => {
    stored('202001');

    expect(await confirmVault(db, config(), LONG_AGO, remote(), () => {})).toEqual({ renamed: 0, again: 0 });
  });

  /** Sent twice, stored twice: the second replaced the first after the first was written down. */
  it('writes down the identifier Mega has now, where the size is the one sent', async () => {
    const file = stored('202001');

    held.set('spot/trades/@/202001.parquet', { bytes: 10, handle: 'SECOND' });

    expect(await confirmVault(db, config(), LONG_AGO, remote(), () => {})).toEqual({ renamed: 1, again: 0 });
    expect(record.vaultFilesOf(db, file.partition, 'r1')[0]).toMatchObject({ state: 'stored', handle: 'SECOND' });
  });

  it('has sent again what is there at another size, or not there', async () => {
    const wrong = stored('202001');
    const gone  = stored('202002');

    held.set('spot/trades/@/202001.parquet', { bytes: 9, handle: 'FIRST' });
    held.delete('spot/trades/@/202002.parquet');

    expect(await confirmVault(db, config(), LONG_AGO, remote(), () => {})).toEqual({ renamed: 0, again: 2 });
    expect(record.vaultFilesOf(db, wrong.partition, 'r1')[0]!.state).toBe('planned');
    expect(record.vaultFilesOf(db, gone.partition, 'r1')[0]!.state).toBe('planned');
    expect(record.vaultStored(db).size).toBe(0);
  });

  it('looks only at what was stored since the moment given', async () => {
    stored('202001');
    held.clear();

    expect(await confirmVault(db, config(), '2999-01-01T00:00:00.000Z', remote(), () => {})).toEqual({ renamed: 0, again: 0 });
  });
});

describe('a second look at tars just stored', () => {
  const partition = (month: string): CatalogPartition => ({
    venue: 'gate', market: 'spot', dataset: 'trades', variant: '', grain: 'daily', bundle: 'instrument', month, files: 1, bytes: 2, version: 'v1',
  });

  const tar = (month: string): number => {
    const id = record.planTar(db, 'archives', 'gate', month, seq => ({ remote: `gate/${month}.${seq}.tar`, local: `gate/${month}.${seq}.tar` }), [partition(month)]);

    record.packed(db, id, 100);
    record.stored(db, id, 'FIRST');

    return id;
  };

  it('writes down a new identifier, and has packed again what is not there as sent', async () => {
    const renamed = tar('202001');
    const gone    = tar('202002');

    const lookup = async (at: string) => (at.includes('202001') ? { bytes: 100, handle: 'SECOND' } : null);

    expect(await confirmTars(db, config(), 'archives', LONG_AGO, () => {}, lookup)).toEqual({ renamed: 1, again: 1 });
    expect(record.tarById(db, renamed)).toMatchObject({ state: 'stored', handle: 'SECOND' });
    expect(record.tarById(db, gone).state).toBe('planned');
  });
});

describe('second transfers of the same file in the queue', () => {
  const queue = [
    'TAG|STATE|SOURCEPATH|DESTINYPATH',
    '10|ACTIVE|/data/vault/a.parquet|/T/a.parquet',
    '11|QUEUED|/data/vault/a.parquet|/T/a.parquet',
    '12|QUEUED|/data/vault/b.parquet|/T/b.parquet',
    '14|QUEUED|/data/vault/c.parquet|/T/c.parquet',
    '13|QUEUED|/data/vault/c.parquet|/T/c.parquet',
    '15|ACTIVE|/data/vault/d.parquet|/T/d.parquet',
    '9|QUEUED|/data/vault/d.parquet|/T/d.parquet',
    '20|QUEUED|/home/me/photo.jpg|/Photos/photo.jpg',
    '21|QUEUED|/home/me/photo.jpg|/Photos/photo.jpg',
  ].join('\n');

  /** The one being sent is kept, else the first asked for. */
  it('are the ones to cancel, of what is below the directories given', () => {
    expect(duplicatesIn(queue, ['/data/vault']).sort()).toEqual(['11', '14', '9']);
  });

  /** The queue is shared with whatever else is uploading. */
  it('are never somebody else\'s', () => {
    expect(duplicatesIn(queue, ['/data/other'])).toEqual([]);
  });
});
