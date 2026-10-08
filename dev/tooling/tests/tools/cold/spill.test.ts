import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _test_evictable as evictable } from '../../../src/tools/cold/evict/vault';
import { Archives } from '../../../src/tools/cold/shared/disk';
import * as record from '../../../src/tools/cold/shared/record';
import { stockedIn } from '../../../src/tools/cold/shared/vault/ledger';
import { completable } from '../../../src/tools/cold/shared/vault/spill';
import type { DatabaseSync } from 'node:sqlite';
import type { ListedSlice, VaultFile } from '../../../src/tools/cold/shared/types';
import type { ColdConfig } from '../../../src/tools/cold/types';

/**
 * Partitions stocked without a neighbouring month's hours, once that month's
 * archives are on disk: which they are, and that their own files stay.
 */

let dir: string;
let db:  DatabaseSync;
let catalog: ListedSlice[];

const config = (): ColdConfig => ({
  sourceRoot: path.join(dir, 'archives'), vaultRoot: path.join(dir, 'vault'), coldRoot: dir, megaRoot: '/x', backupRoot: '/x/@cold',
  dbPath: path.join(dir, 'cold.sqlite'), capBytes: 1e12, queueTargetGb: 10, settledHours: null, catalogUrl: 'http://catalog.test', catalogToken: '',
});

const SLICE = 'venue=gate/market=spot/dataset=trades';

/** A ledger line for a month, with what it says of the hours the next month holds of it. */
const stock = (month: string, post: string): void => {
  const file = path.join(dir, 'vault', 'ledger.csv');

  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (! fs.existsSync(file)) fs.writeFileSync(file, 'partition|venue|market|dataset|variant|grain|bundle|month|mode|version|preVersion|postVersion|revision|size|count|stockedAt\n');

  fs.appendFileSync(file, `${SLICE}/${month}|gate|spot|trades||daily|instrument|${month}|bundle|v1||${post}|r1|10|1|T\n`);
};

/** A month's archives: in the catalog as downloaded, and on disk unless told otherwise. */
const archive = (month: string, onDisk = true): void => {
  catalog.push({ market: 'spot', dataset: 'trades', variant: '', grain: 'daily', bundle: 'instrument', partitions: [{ month, files: 1, bytes: 2, version: 'v1' }] });

  if (! onDisk) return;

  const file = path.join(dir, 'archives', 'gate/spot/trades/B/BTC_USDT', month, `gate|spot|trades|BTC_USDT|${month}01.csv.gz`);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'aa');
};

const waiting = async (): Promise<string[]> =>
  (await completable(config(), new Archives(config().sourceRoot), stockedIn(config().vaultRoot) ?? [])).map(one => one.partition);

beforeEach(() => {
  dir     = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-spill-'));
  db      = record.open(path.join(dir, 'cold.sqlite'));
  catalog = [];

  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: catalog }), { status: 200 })));
});

afterEach(() => {
  record.close(db);
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a partition stocked without the next month\'s hours', () => {
  it('can be completed once that month\'s archives are on disk', async () => {
    stock('202012', 'missing');
    archive('202101');

    expect(await waiting()).toEqual([`${SLICE}/202012`]);
  });

  it('cannot while they are not on disk, whatever the catalog says', async () => {
    stock('202012', 'missing');
    archive('202101', false);

    expect(await waiting()).toEqual([]);
  });

  it('is not one where it has those hours, or has none to have', async () => {
    stock('202011', 'abcdef0123456789');
    stock('202012', '');
    archive('202012');
    archive('202101');

    expect(await waiting()).toEqual([]);
  });

  /** Its own files are what the hours are added beside: they do not leave while that can happen. */
  it('keeps its own files on disk while it can be completed', async () => {
    const file: VaultFile = { partition: `${SLICE}/202012`, revision: 'r1', instrument: '@', side: '', path: `${SLICE}/@/202012.parquet`, bytes: 10 };

    stock('202012', 'missing');
    archive('202101');

    record.planVaultFiles(db, [file]);
    record.moveVaultFile(db, file, 'stored', 'H');
    record.storeVaultPartition(db, file.partition, file.revision);

    const all = { venues: [], instruments: [] };

    expect(evictable(db, config(), all)).toHaveLength(1);
    expect(evictable(db, config(), all, new Set(await waiting()))).toEqual([]);
  });
});
