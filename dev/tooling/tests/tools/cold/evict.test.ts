import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Archives } from '../../../src/tools/cold/disk';
import { _test_remove as remove, _test_survey as survey } from '../../../src/tools/cold/evict';
import * as record from '../../../src/tools/cold/record';
import { errorsIn, evictedFrom, stockedIn } from '../../../src/tools/cold/vault';
import type { DatabaseSync } from 'node:sqlite';
import type { CatalogPartition, ColdConfig, Grain, ListedSlice } from '../../../src/tools/cold/types';

/**
 * What of the archives can leave the disk: only what cold storage holds and
 * the vault was stocked from, with the months either side of it stocked too.
 */

let dir:      string;
let db:       DatabaseSync;
let catalog:  ListedSlice[];
let settled:  Set<string>;

const MONTHS = ['202001', '202002', '202003', '202004'];

const config = (): ColdConfig => ({
  sourceRoot: path.join(dir, 'archives'), vaultRoot: path.join(dir, 'vault'), coldRoot: dir, megaRoot: '/x',
  dbPath: path.join(dir, 'cold.sqlite'), capBytes: 1e12, queueTargetGb: 10, settledHours: null,
  catalogUrl: 'http://catalog.test', catalogToken: 't',
});

const partition = (month: string, grain: Grain = 'daily', version = 'v1'): CatalogPartition => ({
  venue: 'gate', market: 'spot', dataset: 'trades', variant: '', grain, bundle: 'instrument',
  month, files: 1, bytes: 2, version,
});

/** A file of a partition in the archives, under the name the catalog gives it. */
const onDisk = (month: string, grain: Grain = 'daily'): string => {
  const name = `gate|spot|trades|BTC_USDT|${grain === 'daily' ? `${month}01` : month}.csv.gz`;
  const file = path.join('gate/spot/trades/B/BTC_USDT', month, name);

  fs.mkdirSync(path.dirname(path.join(dir, 'archives', file)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'archives', file), 'aa');

  return file;
};

/** The catalog holds these, and says the settled ones are downloaded and settled. */
const publish = (partitions: CatalogPartition[]): void => {
  catalog = [];

  for (const one of partitions) {
    let slice = catalog.find(held => held.grain === one.grain);

    if (! slice) catalog.push(slice = { market: one.market, dataset: one.dataset, variant: one.variant, grain: one.grain, bundle: one.bundle, partitions: [] });

    slice.partitions.push({ month: one.month, files: one.files, bytes: one.bytes, version: one.version });
  }
};

/** Cold storage holds these, in a tar that is stored. */
const store = (...partitions: CatalogPartition[]): void => {
  for (const one of partitions) {
    const id = record.planTar(db, 'archives', 'gate', one.month, seq => ({ remote: `r${one.month}${one.grain}${seq}`, local: `l${one.month}${one.grain}${seq}` }), [one]);

    record.packed(db, id, 10);
    record.stored(db, id, 'H');
  }
};

/** The vault's ledger says these were stocked, each from the partition given. */
const stock = (...lines: (CatalogPartition & { pre?: string; post?: string })[]): void => {
  fs.mkdirSync(path.join(dir, 'vault'), { recursive: true });

  const head = 'partition|venue|market|dataset|variant|grain|bundle|month|mode|version|preVersion|postVersion|revision|size|count|stockedAt';
  const file = path.join(dir, 'vault', 'ledger.csv');

  if (! fs.existsSync(file)) fs.writeFileSync(file, `${head}\n`);

  for (const one of lines)
    fs.appendFileSync(file, [
      `venue=gate/market=spot/dataset=trades/${one.month}`, one.venue, one.market, one.dataset, one.variant, one.grain,
      one.bundle, one.month, 'bundle', one.version, one.pre ?? '', one.post ?? '', 'abcdef012345', 10, 1, 'T',
    ].join('|') + '\n');
};

const look = (now?: number) =>
  survey(db, config(), 'archives', 'gate', stockedIn(config().vaultRoot) ?? [], evictedFrom(config().vaultRoot), now);

const evictable = async (now?: number): Promise<string[]> =>
  (await look(now)).ready.map(one => `${one.month} ${one.grain}`);

/** Remove what a look found, outright: the trash is the host's, and not a test's to fill. */
const evict = async () => remove(db, config(), 'archives', await look(), new Archives(config().sourceRoot), true);

beforeEach(() => {
  dir     = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-evict-'));
  db      = record.open(path.join(dir, 'cold.sqlite'));
  catalog = [];
  settled = new Set(MONTHS);

  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const asked = new URL(url).searchParams.get('settled') === 'true';

    const items = catalog.map(slice => ({
      ...slice, partitions: slice.partitions.filter(one => ! asked || settled.has(one.month)),
    })).filter(slice => slice.partitions.length > 0);

    return new Response(JSON.stringify({ items }), { status: 200 });
  }));

  // Four months, every one downloaded, stored and stocked.
  const all = MONTHS.map(month => partition(month));

  publish(all);
  store(...all);
  stock(...all);

  for (const month of MONTHS) onDisk(month);
});

afterEach(() => {
  vi.unstubAllGlobals();
  record.close(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('what of the archives can be evicted', () => {
  /** The first month has none before it and the last none after: each waits only on the neighbour it has. */
  it('is everything stored and stocked, the first and the last month with it', async () => {
    expect(await evictable()).toEqual(['202001 daily', '202002 daily', '202003 daily', '202004 daily']);
  });

  /**
   * A month can be settled fifteen days after it ends. So the newest month that
   * can be settled today has nothing after it yet — which is the venue not
   * having published it, and no sign that the dataset has ended.
   */
  it('does not take a month for the last while the month after it has not had its time', async () => {
    // 6 May: April ended six days ago, so March is the newest month that can be settled, and April is not it.
    expect(await evictable(Date.UTC(2020, 4, 6))).toEqual(['202001 daily', '202002 daily', '202003 daily']);
    expect((await look(Date.UTC(2020, 4, 6))).held).toMatchObject({ 'a neighbouring month is not stocked': 1 });

    // 16 May: April can be settled now, and still has nothing after it that could be.
    expect(await evictable(Date.UTC(2020, 4, 16))).toEqual(['202001 daily', '202002 daily', '202003 daily']);
  });

  /** May could have been settled by now and never came: April was the last. */
  it('takes a month for the last once the month after it could have been settled and is not there', async () => {
    expect(await evictable(Date.UTC(2020, 5, 15))).toEqual(['202001 daily', '202002 daily', '202003 daily']);
    expect(await evictable(Date.UTC(2020, 5, 16))).toEqual(['202001 daily', '202002 daily', '202003 daily', '202004 daily']);
  });

  /** The months after it are there and not settled yet, so it has a neighbour, and waits. */
  it('does not take the last settled month for the last there is', async () => {
    publish([...MONTHS, '202005'].map(month => partition(month)));
    onDisk('202005');

    expect(await evictable()).toEqual(['202001 daily', '202002 daily', '202003 daily']);
    expect((await look()).held).toMatchObject({ 'a neighbouring month is not stocked': 1 });
  });

  it('leaves what cold storage does not hold, or holds at another version', async () => {
    publish(MONTHS.map(month => partition(month, 'daily', month === '202002' ? 'v2' : 'v1')));
    stock(partition('202002', 'daily', 'v2'));

    expect(await evictable()).toEqual(['202001 daily', '202003 daily', '202004 daily']);
    expect((await look()).held).toMatchObject({ 'not in cold storage': 1 });
  });

  /** A tar that is planned, packed or on its way is not cold storage yet. */
  it('leaves what is only on its way to cold storage', async () => {
    const late = partition('202002', 'monthly');

    publish([...MONTHS.map(month => partition(month)), late]);
    record.planTar(db, 'archives', 'gate', '202002', seq => ({ remote: `late${seq}`, local: `late${seq}` }), [late]);
    onDisk('202002', 'monthly');

    expect(await evictable()).not.toContain('202002 monthly');
  });

  it('leaves what the vault was not stocked from at the catalog\'s version', async () => {
    fs.rmSync(path.join(dir, 'vault', 'ledger.csv'));
    stock(partition('202001'), partition('202002', 'daily', 'old'), partition('202003'), partition('202004'));

    // 202002 is not stocked as it is now, so neither it nor the months beside it can go.
    expect(await evictable()).toEqual(['202004 daily']);
    expect((await look()).held).toMatchObject({ 'not stocked': 1, 'a neighbouring month is not stocked': 2 });
  });

  /** The last line for a partition is the one that counts. */
  it('reads the last line the ledger has for a partition', async () => {
    stock(partition('202002', 'daily', 'old'));

    expect(await evictable()).toEqual(['202004 daily']);

    stock(partition('202002'));

    expect(await evictable()).toEqual(['202001 daily', '202002 daily', '202003 daily', '202004 daily']);
  });

  /** Which rendering the vault was built from is its own business: none is needed any more. */
  it('lets every rendering of a month go once any of them is stocked', async () => {
    const monthly = MONTHS.map(month => partition(month, 'monthly'));

    publish([...MONTHS.map(month => partition(month)), ...monthly]);
    store(...monthly);

    for (const month of MONTHS) onDisk(month, 'monthly');

    expect(await evictable()).toEqual([
      '202001 daily', '202002 daily', '202003 daily', '202004 daily',
      '202001 monthly', '202002 monthly', '202003 monthly', '202004 monthly',
    ]);
  });

  /** Stocked reading the edge of a neighbour: current only while that neighbour is what it was. */
  it('takes a month as stocked only while the neighbours it read are unchanged', async () => {
    fs.rmSync(path.join(dir, 'vault', 'ledger.csv'));
    stock(partition('202001'), { ...partition('202002'), pre: 'v1', post: 'v0' }, partition('202003'), partition('202004'));

    expect((await look()).held).toMatchObject({ 'not stocked': 1 });
  });

  it('holds a month whose neighbour is not stocked, and not the first for having none before it', async () => {
    fs.rmSync(path.join(dir, 'vault', 'ledger.csv'));
    stock(partition('202001'), partition('202002'), partition('202004'));

    expect(await evictable()).toEqual(['202001 daily']);
  });

  /** A month the venue published nothing in is nobody's neighbour. */
  it('does not wait on a month the dataset does not have', async () => {
    const some = ['202001', '202003', '202004'].map(month => partition(month));

    publish(some);
    fs.rmSync(path.join(dir, 'vault', 'ledger.csv'));
    stock(...some);

    expect(await evictable()).toEqual(['202001 daily', '202003 daily', '202004 daily']);
  });

  /** Only what is settled is a candidate — and what is not yet settled is still a month that exists. */
  it('considers only settled partitions, and counts the others as months to come', async () => {
    settled = new Set(['202001', '202002']);

    expect(await evictable()).toEqual(['202001 daily', '202002 daily']);
  });

  /** Whatever the archives hold of it goes — all of it, some of it, or none — so the disk is not asked. */
  it('does not look at the disk to decide', async () => {
    fs.rmSync(path.join(dir, 'archives'), { recursive: true });

    expect(await evictable()).toHaveLength(4);
  });

  /** The record says what went, so it is not offered again — until its version moves. */
  it('leaves out what was evicted already, at the version it has now', async () => {
    record.noteEviction(db, 'archives', partition('202001'), { files: 1, bytes: 2 });

    const found = await look();

    expect(found.gone).toBe(1);
    expect(found.ready.map(one => one.month)).toEqual(['202002', '202003', '202004']);
  });

  it('offers again a partition that changed since it was evicted, once it is stored and stocked anew', async () => {
    record.noteEviction(db, 'archives', partition('202001', 'daily', 'v0'), { files: 1, bytes: 2 });

    expect((await look()).gone).toBe(0);
    expect(await evictable()).toHaveLength(4);
  });

  /** A vault partition moved out is not accounted for until the vault is in cold storage too. */
  it('does not take a vault partition marked as moved out for stocked', async () => {
    fs.writeFileSync(path.join(dir, 'vault', 'evicted.csv'),
      'partition|revision|evicted|date\nvenue=gate/market=spot/dataset=trades/202002|abcdef012345|true|T\n');

    expect(await evictable()).toEqual(['202004 daily']);

    fs.appendFileSync(path.join(dir, 'vault', 'evicted.csv'),
      'venue=gate/market=spot/dataset=trades/202002|abcdef012345|false|T\n');

    expect(await evictable()).toHaveLength(4);
  });
});

describe('evicting', () => {
  it('removes the files, the directories they emptied, and writes down what went', async () => {
    expect(await evict()).toEqual({ files: 4, bytes: 8 });

    expect(fs.readdirSync(path.join(dir, 'archives', 'gate/spot/trades/B/BTC_USDT'))).toEqual([]);
    expect(db.prepare('SELECT month, version, files, bytes FROM eviction ORDER BY month').all())
      .toEqual(MONTHS.map(month => ({ month, version: 'v1', files: 1, bytes: 2 })));
  });

  /** A directory holds every grain of a month side by side. */
  it('leaves a directory another rendering still has files in', async () => {
    const monthly = MONTHS.map(month => partition(month, 'monthly'));

    publish([...MONTHS.map(month => partition(month)), ...monthly]);

    const kept = onDisk('202001', 'monthly');

    await evict();

    expect(fs.existsSync(path.join(dir, 'archives', kept))).toBe(true);
  });

  /** Every rendering in it is going, so the directory is one thing to remove. */
  it('takes a directory whole where every rendering in it is going, and counts each one\'s files', async () => {
    const monthly = MONTHS.map(month => partition(month, 'monthly'));

    publish([...MONTHS.map(month => partition(month)), ...monthly]);
    store(...monthly);

    for (const month of MONTHS) onDisk(month, 'monthly');

    expect(await evict()).toEqual({ files: 8, bytes: 16 });
    expect(fs.readdirSync(path.join(dir, 'archives', 'gate/spot/trades/B/BTC_USDT'))).toEqual([]);
    expect(db.prepare('SELECT grain, sum(files) AS files FROM eviction GROUP BY grain ORDER BY grain').all())
      .toEqual([{ grain: 'daily', files: 4 }, { grain: 'monthly', files: 4 }]);
  });

  /** A file that is nobody's is not this command's to take. */
  it('picks the partition\'s files out of a directory that holds anything else', async () => {
    const stray = path.join(dir, 'archives', 'gate/spot/trades/B/BTC_USDT/202001/notes.txt');

    fs.writeFileSync(stray, 'kept');

    await evict();

    expect(fs.readdirSync(path.dirname(stray))).toEqual(['notes.txt']);
  });

  it('finds nothing more to evict afterwards', async () => {
    await evict();

    expect((await look()).ready).toEqual([]);
    expect((await look()).gone).toBe(4);
  });
});

describe('the vault\'s account of itself', () => {
  it('is nothing where the vault has no ledger', () => {
    fs.rmSync(path.join(dir, 'vault', 'ledger.csv'));

    expect(stockedIn(config().vaultRoot)).toBeNull();
  });

  it('gives what the vault was found not to hold', () => {
    expect(errorsIn(config().vaultRoot)).toEqual([]);

    fs.writeFileSync(path.join(dir, 'vault', 'ERROR.log'), 'T|p|r|its files are not in the vault\n');

    expect(errorsIn(config().vaultRoot)).toEqual(['T|p|r|its files are not in the vault']);
  });
});
