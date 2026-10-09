import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fitting } from '../../../src/tools/cold/pull/needed';
import * as record from '../../../src/tools/cold/shared/record';
import { outdatedIn, stockedIn } from '../../../src/tools/cold/shared/vault/ledger';
import { neededOf } from '../../../src/tools/cold/shared/vault/needed';
import type { DatabaseSync } from 'node:sqlite';
import type { CatalogPartition, ListedSlice, Needed, VaultFile } from '../../../src/tools/cold/shared/types';
import type { ColdConfig, Tar } from '../../../src/tools/cold/types';

/**
 * What the vault waits for that is in cold storage: the archives an outdated
 * partition is stocked again from, and the vault files a neighbouring month's
 * hours are added beside.
 */

let dir: string;
let db:  DatabaseSync;
let catalog: ListedSlice[];

const config = (): ColdConfig => ({
  sourceRoot: path.join(dir, 'archives'), vaultRoot: path.join(dir, 'vault'), coldRoot: dir, megaRoot: '/x', backupRoot: '/x/@cold',
  catalogDb: path.join(dir, 'catalog.db'), catalogRoot: '/x/@catalog',
  dbPath: path.join(dir, 'cold.sqlite'), capBytes: 1e12, queueTargetGb: 10, settledHours: null, catalogUrl: 'http://catalog.test', catalogToken: '',
});

const SLICE = 'venue=gate/market=spot/dataset=trades';

/** A ledger line for a month: stocked at a revision, or saying it is outdated; with what it says of the next month's hours. */
const line = (month: string, revision: string, post = ''): void => {
  const file = path.join(dir, 'vault', 'ledger.csv');

  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (! fs.existsSync(file)) fs.writeFileSync(file, 'partition|venue|market|dataset|variant|grain|bundle|month|mode|version|preVersion|postVersion|revision|size|count|stockedAt\n');

  fs.appendFileSync(file, `${SLICE}/${month}|gate|spot|trades||daily|instrument|${month}|bundle|v1||${post}|${revision}|10|1|T\n`);
};

const partition = (month: string, grain: 'daily' | 'monthly' = 'daily'): CatalogPartition =>
  ({ venue: 'gate', market: 'spot', dataset: 'trades', variant: '', grain, bundle: 'instrument', month, files: 1, bytes: 2, version: 'v1' });

/** A month's archives in the catalog, and on disk unless told otherwise. */
const archive = (month: string, onDisk = true, grain: 'daily' | 'monthly' = 'daily'): void => {
  catalog.push({ market: 'spot', dataset: 'trades', variant: '', grain, bundle: 'instrument', partitions: [{ month, files: 1, bytes: 2, version: 'v1' }] });

  if (! onDisk) return;

  const file = path.join(dir, 'archives', 'gate/spot/trades/B/BTC_USDT', month, `gate|spot|trades|BTC_USDT|${month}${grain === 'daily' ? '01' : ''}.csv.gz`);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'aa');
};

/** Cold storage holds these partitions of the archives, in one tar. */
const store = (...partitions: CatalogPartition[]): number => {
  const id = record.planTar(db, 'archives', 'gate', partitions[0]!.month, seq => ({ remote: `gate/${partitions[0]!.month}.${seq}.tar`, local: `gate/${partitions[0]!.month}.${seq}.tar` }), partitions);

  record.packed(db, id, 100);
  record.stored(db, id, 'H');

  return id;
};

const needed = (): Promise<Needed> => neededOf(db, config(), config());

beforeEach(() => {
  dir     = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-needed-'));
  db      = record.open(path.join(dir, 'cold.sqlite'));
  catalog = [];

  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: catalog }), { status: 200 })));
});

afterEach(() => {
  record.close(db);
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the ledger\'s outdated partitions', () => {
  it('are those whose last line says so, as what they were stocked from', () => {
    line('202011', 'r1');
    line('202012', 'r1');
    line('202012', 'outdated');
    line('202101', 'r1');
    line('202101', 'outdated');
    line('202101', 'r2');

    expect(outdatedIn(config().vaultRoot).map(one => one.source.month)).toEqual(['202012']);
    expect((stockedIn(config().vaultRoot) ?? []).map(one => one.source.month)).toEqual(['202011', '202101']);
  });
});

describe('an outdated partition', () => {
  it('waits for its archives where they are in cold storage and not on disk', async () => {
    line('202012', 'r1');
    line('202012', 'outdated');
    archive('202012', false);

    const id = store(partition('202012'));

    expect(await needed()).toMatchObject({ partitions: 1, vault: [], unstored: [], archives: [{ state: 'away', held: { month: '202012', tarId: id } }] });
  });

  it('waits for nothing where its archives are on disk, in whichever rendering', async () => {
    line('202012', 'r1');
    line('202012', 'outdated');
    archive('202012', false);
    archive('202012', true, 'monthly');
    store(partition('202012'));

    expect(await needed()).toMatchObject({ partitions: 0, archives: [], unstored: [] });
  });

  /** A month that read the edge of the next is stocked again from both. */
  it('waits for the neighbouring month it read the edge of as well', async () => {
    line('202012', 'r1', 'abcdef0123456789');
    line('202012', 'outdated', 'abcdef0123456789');
    archive('202012', false);
    archive('202101', false);
    store(partition('202012'));
    store(partition('202101'));

    const found = await needed();

    expect(found.partitions).toBe(1);
    expect(found.archives.map(one => one.held.month).sort()).toEqual(['202012', '202101']);
  });

  /** Two months that need the same neighbour ask for it once. */
  it('asks once for a month two partitions wait for', async () => {
    line('202012', 'outdated', 'abcdef0123456789');
    line('202101', 'outdated', '');
    archive('202012', false);
    archive('202101', false);
    store(partition('202012'), partition('202101'));

    const found = await needed();

    expect(found.partitions).toBe(2);
    expect(found.archives.map(one => one.held.month).sort()).toEqual(['202012', '202101']);
  });

  it('is said to wait for what cold storage does not hold at the catalog\'s version, and nothing is asked for it', async () => {
    line('202012', 'outdated');
    archive('202012', false);
    store({ ...partition('202012'), version: 'v0' });

    expect(await needed()).toMatchObject({ partitions: 1, archives: [], unstored: ['gate|spot|trades|*|daily|202012'] });
  });

  it('takes the rendering it was stocked from where cold storage holds more than one', async () => {
    line('202012', 'outdated');
    archive('202012', false, 'monthly');
    archive('202012', false);
    store(partition('202012', 'monthly'));
    store(partition('202012'));

    expect((await needed()).archives.map(one => one.held.grain)).toEqual(['daily']);
  });
});

describe('a partition that can be completed', () => {
  it('waits for its own vault files where they have been taken off the disk', async () => {
    const file: VaultFile = { partition: `${SLICE}/202012`, revision: 'r1', instrument: '@', side: '', path: `${SLICE}/@/202012.parquet`, bytes: 10 };

    line('202012', 'r1', 'missing');
    archive('202101');

    record.planVaultFiles(db, [file]);
    record.moveVaultFile(db, file, 'stored', 'H');
    record.storeVaultPartition(db, file.partition, file.revision);

    expect((await needed()).vault).toEqual([]);

    record.noteVaultMoves(db, [file], 'evicted');

    expect(await needed()).toMatchObject({ partitions: 1, archives: [], vault: [{ path: file.path }] });
  });
});

describe('what there is room to bring back', () => {
  const tar = (id: number, bytes: number): Tar => ({ id, bytes } as Tar);
  const of  = (tarId: number, bytes: number): Needed['archives'][number] => ({ state: 'away', held: { ...partition('202012'), tarId, bytes, next: null } });

  it('is tars in order for as long as each, and what comes out of it, leaves the reserve', () => {
    const wanted: Needed = { partitions: 3, vault: [], unstored: [], archives: [of(1, 30), of(2, 30), of(3, 30)] };

    // 130 free, 10 kept: the first leaves 90, the second 60, and the third's tar and files do not fit in that.
    expect(fitting(wanted, [tar(1, 40), tar(2, 40), tar(3, 40)], 130, 10)).toMatchObject({ tars: [{ id: 1 }, { id: 2 }], left: 1 });
    expect(fitting(wanted, [tar(1, 40), tar(2, 40), tar(3, 40)], 1_000, 10)).toMatchObject({ left: 0 });
    expect(fitting(wanted, [tar(1, 40)], 50, 10)).toMatchObject({ tars: [], left: 1 });
  });
});
