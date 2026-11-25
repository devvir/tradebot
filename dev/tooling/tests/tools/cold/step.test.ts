import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { step } from '../../../src/tools/cold/push/archives/step';
import { _test_plan as plan } from '../../../src/tools/cold/push/archives/plan';
import { Archives } from '../../../src/tools/cold/shared/disk';
import * as record from '../../../src/tools/cold/shared/record';
import { sizedMembersOf } from '../../../src/tools/cold/shared/tar';
import type { DatabaseSync } from 'node:sqlite';
import type { PushProgress } from '../../../src/tools/cold/push/progress';
import type { Round } from '../../../src/tools/cold/push/types';
import type { CatalogPartition, Listed } from '../../../src/tools/cold/shared/types';
import type { ColdConfig, TarState } from '../../../src/tools/cold/types';

/**
 * A tar taken through its states against a stand-in for Mega, while the
 * catalog changes what one of its partitions holds. What the record writes down
 * as stored has to be what the tar in Mega holds.
 */

/** Mega, as far as a tar's steps ask of it: a directory, every upload landing at once under a new handle. */
const cloud = vi.hoisted(() => ({ root: '', handles: new Map<string, string>(), uploads: 0 }));

vi.mock('../../../src/tools/cold/shared/mega', async (actual) => {
  const fsm   = await import('node:fs');
  const pathm = await import('node:path');

  return {
    ...await actual<object>(),
    remote: async (remotePath: string): Promise<Listed | null> => {
      const at = pathm.join(cloud.root, remotePath);

      return fsm.existsSync(at) ? { bytes: fsm.statSync(at).size, handle: cloud.handles.get(remotePath) ?? null } : null;
    },
    queueUpload: async (local: string, remoteDir: string): Promise<void> => {
      const remotePath = `${remoteDir}/${pathm.basename(local)}`;

      fsm.mkdirSync(pathm.join(cloud.root, remoteDir), { recursive: true });
      fsm.copyFileSync(local, pathm.join(cloud.root, remotePath));
      cloud.handles.set(remotePath, `H:${++cloud.uploads}`);
    },
    queueDownload: async (remotePath: string, localDir: string): Promise<void> => {
      fsm.copyFileSync(pathm.join(cloud.root, remotePath), pathm.join(localDir, pathm.basename(remotePath)));
    },
  };
});

let dir: string;
let db:  DatabaseSync;

const config = (): ColdConfig => ({
  sourceRoot: path.join(dir, 'archives'), vaultRoot: path.join(dir, 'vault'), coldRoot: path.join(dir, 'cold'), megaRoot: '/m',
  dbPath: path.join(dir, 'cold.sqlite'), capBytes: 1e12, queueTargetGb: 10, settledHours: null,
  catalogUrl: 'http://catalog.test', catalogToken: 't',
});

const progress = {
  working: () => {}, worked: () => {}, verifying: () => {}, stored: () => {}, log: () => {},
} as unknown as PushProgress;

/** Nothing waits in either queue: what is handed over has arrived. */
const round: Round = {
  room: async () => true, packed: () => {}, uploads: async () => new Set(), downloads: async () => new Set(),
};

const MONTH_DIR = path.join('gate', 'spot', 'trades', 'B', 'BTC_USDT', '202001');

/** Each version of the partition, as its files: name to content. */
const VERSIONS: Record<string, Record<string, string>> = {
  v1: { '01': 'aa' },
  v2: { '01': 'bbb', '02': 'cc' },
  v3: { '01': 'bbb', '02': 'cc', '03': 'dddd' },
};

const nameOf = (day: string): string => path.join(MONTH_DIR, `gate|spot|trades|BTC_USDT|202001${day}.csv.gz`);

/** The partition as the catalog says it is at a version. */
const at = (version: string): CatalogPartition => {
  const files = Object.values(VERSIONS[version]!);

  return {
    venue: 'gate', market: 'spot', dataset: 'trades', variant: '', grain: 'daily', bundle: 'instrument', month: '202001',
    files: files.length, bytes: files.reduce((sum, one) => sum + one.length, 0), version,
  };
};

/** The disk holds the partition at a version. */
const onDisk = (version: string): void => {
  fs.rmSync(path.join(dir, 'archives', MONTH_DIR), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'archives', MONTH_DIR), { recursive: true });

  for (const [day, content] of Object.entries(VERSIONS[version]!)) fs.writeFileSync(path.join(dir, 'archives', nameOf(day)), content);
};

/** The catalog now holds the partition at a version, and so does the disk. */
const changeTo = (version: string, id: number): void => {
  onDisk(version);
  record.noteChange(db, record.heldIn(db, id)[0]!, at(version));
};

const tarOf = (id: number) => record.tarById(db, id);

/** One step of the tar. */
const go = async (id: number): Promise<TarState> => {
  await step(db, config(), 'archives', new Archives(config().sourceRoot), tarOf(id), progress, round);

  return tarOf(id).state;
};

/** Steps until the tar is in a state. */
const until = async (id: number, state: TarState): Promise<void> => {
  for (let n = 0; n < 10 && tarOf(id).state !== state; n++) await go(id);

  expect(tarOf(id).state).toBe(state);
};

/** What the tar Mega holds has of the partition, by day and size. */
const inMega = async (id: number): Promise<string[]> =>
  (await sizedMembersOf(path.join(cloud.root, `/m/${tarOf(id).remote}`)))
    .map(one => `${one.path.slice(-9, -7)}:${one.bytes}`).sort();

const planned = (version: string): number => {
  onDisk(version);

  return record.planTar(db, 'archives', 'gate', '202001', seq => ({
    remote: `gate/2020/gate-202001.00${seq}.tar`, local: `gate/gate-202001.00${seq}.tar`,
  }), [at(version)]);
};

/** A tar stored at v1. */
const storedAtV1 = async (): Promise<number> => {
  const id = planned('v1');

  await until(id, 'stored');

  return id;
};

const heldNow = (id: number) => record.heldIn(db, id)[0]!;

beforeEach(() => {
  dir          = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-step-'));
  db           = record.open(path.join(dir, 'cold.sqlite'));
  cloud.root   = path.join(dir, 'mega');
  cloud.uploads = 0;
  cloud.handles.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  record.close(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a tar that changes on its way to Mega', () => {
  it('is stored as it was packed, and corrected, where the change came while it was packed', async () => {
    const id = planned('v1');

    expect(await go(id)).toBe('packed');

    changeTo('v2', id);

    expect(tarOf(id).state).toBe('packed');
    expect(await go(id)).toBe('queued');
    expect(await go(id)).toBe('stale');

    expect(heldNow(id)).toMatchObject({ version: 'v1', files: 1, next: { version: 'v2', files: 2 } });
    expect(record.storedOf(db, 'archives', 'gate')).toEqual([]);
    expect(await inMega(id)).toEqual(['01:2']);

    // Brought back and corrected to what the catalog holds.
    await until(id, 'stored');

    expect(heldNow(id)).toMatchObject({ version: 'v2', files: 2, bytes: 5, next: null, packed: null });
    expect(await inMega(id)).toEqual(['01:3', '02:2']);
  });

  it('is stored as it was packed, and corrected, where the change came while it was queued', async () => {
    const id = planned('v1');

    await until(id, 'queued');

    changeTo('v2', id);

    expect(await go(id)).toBe('stale');
    expect(heldNow(id)).toMatchObject({ version: 'v1', next: { version: 'v2' } });
    expect(record.storedOf(db, 'archives', 'gate')).toEqual([]);

    await until(id, 'stored');

    expect(heldNow(id)).toMatchObject({ version: 'v2', next: null });
    expect(await inMega(id)).toEqual(['01:3', '02:2']);
  });

  it('is stored as corrected, and corrected again, where the catalog moved on while the correction was queued', async () => {
    const id = await storedAtV1();

    changeTo('v2', id);
    await until(id, 'packed');

    expect(heldNow(id)).toMatchObject({ version: 'v1', packed: { version: 'v2', files: 2, bytes: 5 } });

    expect(await go(id)).toBe('queued');

    changeTo('v3', id);

    expect(await go(id)).toBe('stale');
    expect(heldNow(id)).toMatchObject({ version: 'v2', files: 2, next: { version: 'v3', files: 3 } });
    expect(await inMega(id)).toEqual(['01:3', '02:2']);
    expect(record.storedOf(db, 'archives', 'gate')).toEqual([]);

    await until(id, 'stored');

    expect(heldNow(id)).toMatchObject({ version: 'v3', next: null });
    expect(await inMega(id)).toEqual(['01:3', '02:2', '03:4']);
  });

  it('is stored at the new version where nothing changes while the correction is on its way', async () => {
    const id = await storedAtV1();

    changeTo('v2', id);

    expect(tarOf(id).state).toBe('stale');

    await until(id, 'stored');

    expect(heldNow(id)).toMatchObject({ version: 'v2', files: 2, bytes: 5, next: null });
    expect(record.storedOf(db, 'archives', 'gate').map(one => one.version)).toEqual(['v2']);
  });

  /** What Mega holds is described until the correction is confirmed: lost on the way, it is fetched again. */
  it('is fetched again where the corrected tar is lost from staging before it is sent', async () => {
    const id = await storedAtV1();

    changeTo('v2', id);
    await until(id, 'packed');

    fs.rmSync(path.join(config().coldRoot, 'archives', tarOf(id).local));

    expect(await go(id)).toBe('stale');
    expect(heldNow(id)).toMatchObject({ version: 'v1', next: { version: 'v2' } });

    await until(id, 'stored');

    expect(heldNow(id)).toMatchObject({ version: 'v2', next: null });
  });
});

describe('a tar Mega has held, sent back to be packed again', () => {
  it('is packed at the version noted as changed', async () => {
    const id = await storedAtV1();

    changeTo('v2', id);
    record.move(db, id, 'planned');

    await until(id, 'stored');

    expect(heldNow(id)).toMatchObject({ version: 'v2', next: null });
    expect(await inMega(id)).toEqual(['01:3', '02:2']);
  });
});

/** The catalog goes back to what cold storage holds before the correction lands. */
describe('a change the catalog takes back', () => {
  let slices: { market: string; dataset: string; variant: string; grain: string; bundle: string; partitions: object[] }[];

  const catalogAt = (version: string): void => {
    const { files, bytes } = at(version);

    slices = [{ market: 'spot', dataset: 'trades', variant: '', grain: 'daily', bundle: 'instrument', partitions: [{ month: '202001', files, bytes, version }] }];
  };

  const replan = () => plan(db, config(), 'archives', ['gate'], null, () => {});

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: slices }), { status: 200 })));
  });

  it('is taken back where the tar has not been brought back yet', async () => {
    const id = await storedAtV1();

    catalogAt('v2');
    onDisk('v2');
    await replan();

    expect(tarOf(id).state).toBe('stale');

    catalogAt('v1');
    onDisk('v1');
    await replan();

    expect(tarOf(id)).toMatchObject({ state: 'stored', handle: 'H:1' });
    expect(heldNow(id)).toMatchObject({ version: 'v1', next: null });
  });

  it('is corrected back to what the catalog holds where the tar was already brought back', async () => {
    const id = await storedAtV1();

    catalogAt('v2');
    onDisk('v2');
    await replan();
    await until(id, 'fetched');

    catalogAt('v1');
    onDisk('v1');
    await replan();

    expect(heldNow(id).next).toMatchObject({ version: 'v1', files: 1, bytes: 2 });

    await until(id, 'stored');

    expect(heldNow(id)).toMatchObject({ version: 'v1', next: null });
    expect(await inMega(id)).toEqual(['01:2']);
  });
});
