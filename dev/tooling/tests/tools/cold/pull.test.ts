import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Archives } from '../../../src/tools/cold/shared/disk';
import { filterOf, means, preferenceOf, preferred } from '../../../src/tools/cold/pull/filter';
import { setYes } from '../../../src/tools/cold/options';
import { _test_bring as bring } from '../../../src/tools/cold/pull/archives/bring';
import { _test_chosen as chosen } from '../../../src/tools/cold/pull/archives';
import { _test_survey as survey } from '../../../src/tools/cold/pull/archives/survey';
import * as record from '../../../src/tools/cold/shared/record';
import type { DatabaseSync } from 'node:sqlite';
import type { CatalogPartition, ListedSlice } from '../../../src/tools/cold/shared/types';
import type { ColdConfig } from '../../../src/tools/cold/types';
import type { Fetching, PullFilter, Pullable } from '../../../src/tools/cold/pull/types';

/**
 * Bringing the archives back: what a filter means, how each stored partition
 * stands against the disk and the catalog, what is asked, and what a tar is
 * taken apart into.
 */

let dir:     string;
let db:      DatabaseSync;
let catalog: ListedSlice[];

const config = (): ColdConfig => ({
  sourceRoot: path.join(dir, 'archives'), vaultRoot: path.join(dir, 'vault'), coldRoot: path.join(dir, 'cold'), megaRoot: '/x',
  dbPath: path.join(dir, 'cold.sqlite'), capBytes: 1e12, queueTargetGb: 10, settledHours: null,
  catalogUrl: 'http://catalog.test', catalogToken: 't',
});

const partition = (month: string, dataset = 'trades', version = 'v1'): CatalogPartition => ({
  venue: 'gate', market: 'spot', dataset, variant: '', grain: 'daily', bundle: 'instrument',
  month, files: 1, bytes: 2, version,
});

const fileOf = (one: CatalogPartition): string =>
  path.join(`gate/spot/${one.dataset}/B/BTC_USDT`, one.month, `gate|spot|${one.dataset}|BTC_USDT|${one.month}01.csv.gz`);

/** A file of a partition in the archives. */
const onDisk = (one: CatalogPartition, content = 'aa'): void => {
  fs.mkdirSync(path.dirname(path.join(dir, 'archives', fileOf(one))), { recursive: true });
  fs.writeFileSync(path.join(dir, 'archives', fileOf(one)), content);
};

/** The catalog holds these. */
const publish = (...partitions: CatalogPartition[]): void => {
  catalog = partitions.map(one => ({
    market: one.market, dataset: one.dataset, variant: one.variant, grain: one.grain, bundle: one.bundle,
    partitions: [{ month: one.month, files: one.files, bytes: one.bytes, version: one.version }],
  }));
};

/** Cold storage holds these in one tar — a real one, in "Mega" — packed from what is on disk, which is then taken away. */
const store = (...partitions: CatalogPartition[]): number => {
  const id = record.planTar(db, 'archives', 'gate', partitions[0]!.month, seq => ({ remote: `gate/t${seq}.tar`, local: `gate/t${seq}.tar` }), partitions);

  for (const one of partitions) onDisk(one);

  fs.mkdirSync(path.join(dir, 'mega', 'gate'), { recursive: true });
  execFileSync('tar', ['-cf', path.join(dir, 'mega', record.tarById(db, id).remote), '-C', path.join(dir, 'archives'), ...partitions.map(fileOf)]);

  record.packed(db, id, fs.statSync(path.join(dir, 'mega', record.tarById(db, id).remote)).size);
  record.stored(db, id, 'H');

  fs.rmSync(path.join(dir, 'archives'), { recursive: true });

  return id;
};

/** Mega, as far as bringing a tar back goes: the file appears where it was asked for. */
const remote = (): Fetching & { asked: string[] } => {
  const asked: string[] = [];

  return {
    asked,
    downloadingPaths: async () => new Set<string>(),
    queueDownload: async (from: string, into: string) => {
      asked.push(from);
      fs.copyFileSync(path.join(dir, 'mega', from.replace(/^\/x\//, '')), path.join(into, path.basename(from)));
    },
  };
};

const look = (filter: PullFilter = {}): Promise<Pullable[]> =>
  survey(db, config(), 'archives', 'gate', { filter }, new Archives(config().sourceRoot));

const states = async (filter?: PullFilter): Promise<string[]> => (await look(filter)).map(one => `${one.held.dataset} ${one.held.month} ${one.state}`);

const pull = async (found: Pullable[], mega = remote()) =>
  bring(db, config(), 'archives', [...new Set(found.map(one => one.held.tarId))].map(id => record.tarById(db, id)), found, mega, 1, 0);

beforeEach(() => {
  dir     = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-pull-'));
  db      = record.open(path.join(dir, 'cold.sqlite'));
  catalog = [];

  fs.mkdirSync(path.join(dir, 'cold'), { recursive: true });

  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: catalog }), { status: 200 })));
});

afterEach(() => {
  setYes(false);
  record.close(db);
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('what a pull is narrowed to', () => {
  it('reads a dataset, with or without its variant', () => {
    expect(filterOf({ dataset: 'klines' })).toEqual({ dataset: 'klines' });
    expect(filterOf({ dataset: 'books,incremental,400' })).toEqual({ dataset: 'books', variant: 'incremental,400' });
  });

  it('reads a partition, or as much of one as is given from the left', () => {
    expect(filterOf({ partition: 'spot' })).toEqual({ market: 'spot' });
    expect(filterOf({ partition: 'spot/klines' })).toEqual({ market: 'spot', dataset: 'klines' });
    expect(filterOf({ partition: 'spot/klines,1h' })).toEqual({ market: 'spot', dataset: 'klines', variant: '1h' });
    expect(filterOf({ partition: 'spot/klines,1h/2020' })).toEqual({ market: 'spot', dataset: 'klines', variant: '1h', from: '202001', to: '202012' });
    expect(filterOf({ partition: 'spot/klines,1h/202003' })).toMatchObject({ from: '202003', to: '202003' });
  });

  it('narrows either by a year or a month', () => {
    expect(filterOf({ dataset: 'trades', date: '2020' })).toEqual({ dataset: 'trades', from: '202001', to: '202012' });
    expect(filterOf({ partition: 'spot/trades', date: '202005' })).toMatchObject({ from: '202005', to: '202005' });
  });

  it('refuses a venue alone, both at once, a month said twice, and what it cannot read', () => {
    expect(() => filterOf({})).toThrow(/--dataset or --partition/);
    expect(() => filterOf({ dataset: 'trades', partition: 'spot' })).toThrow(/give one/);
    expect(() => filterOf({ partition: 'spot/trades/2020', date: '2020' })).toThrow(/one too many/);
    expect(() => filterOf({ dataset: 'trades', date: '20' })).toThrow(/YYYY or YYYYMM/);
    expect(() => filterOf({ partition: 'spot/trades/2020/x' })).toThrow(/not a partition/);
  });

  /** A dataset without a variant named is every variant of it; one named is that one alone. */
  it('means every variant of a dataset unless one is named', () => {
    const one = { market: 'spot', dataset: 'klines', variant: '1h', month: '202003' };

    expect(means({ dataset: 'klines' }, one)).toBe(true);
    expect(means({ dataset: 'klines', variant: '1h' }, one)).toBe(true);
    expect(means({ dataset: 'klines', variant: '1m' }, one)).toBe(false);
    expect(means({ market: 'perp' }, one)).toBe(false);
    expect(means({ from: '202001', to: '202002' }, one)).toBe(false);
  });
});

describe('which rendering of the same data', () => {
  const one = (grain: string, bundle: string, month = '202001') => ({ market: 'spot', dataset: 'trades', variant: '', month, grain, bundle });

  const both = [one('monthly', 'instrument'), one('daily', 'instrument'), one('daily', 'market')];

  it('is every one of them where nothing is preferred', () => {
    expect(preferred(both)).toEqual(both);
  });

  it('is the grain preferred, then the bundle preferred', () => {
    expect(preferred(both, { grain: 'monthly' })).toEqual([both[0]]);
    expect(preferred(both, { grain: 'daily' })).toEqual([both[1], both[2]]);
    expect(preferred(both, { grain: 'daily', bundle: 'market' })).toEqual([both[2]]);
  });

  /** A preference, not a filter: nobody should have to look first at what each month is stored as. */
  it('is whatever is stored where the one preferred is not', () => {
    const daily = [one('daily', 'instrument', '202002')];

    expect(preferred(daily, { grain: 'monthly', bundle: 'market' })).toEqual(daily);
  });

  it('is read off the command line, one of each kind at the most', () => {
    expect(preferenceOf({})).toEqual({});
    expect(preferenceOf({ preferDaily: true, preferBundled: true })).toEqual({ grain: 'daily', bundle: 'market' });
    expect(preferenceOf({ preferMonthly: true, preferNotBundled: true })).toEqual({ grain: 'monthly', bundle: 'instrument' });
    expect(() => preferenceOf({ preferMonthly: true, preferDaily: true })).toThrow(/one or the other/);
    expect(() => preferenceOf({ preferBundled: true, preferNotBundled: true })).toThrow(/one or the other/);
  });
});

describe('how a stored partition stands', () => {
  it('tells what is away, what is on disk as stored, what differs, and what is of an older version', async () => {
    const [away, same, differs, old] = ['202001', '202002', '202003', '202004'].map(month => partition(month));

    store(away!, same!, differs!, old!);
    publish(away!, same!, differs!, { ...old!, version: 'v2' });

    onDisk(same!);
    onDisk(differs!, 'aaaa');
    onDisk(old!);

    expect(await states()).toEqual(['trades 202001 away', 'trades 202002 same', 'trades 202003 differs', 'trades 202004 old']);
  });

  it('looks only at what the filter means', async () => {
    store(partition('202001'), partition('202002'), partition('202001', 'klines'));
    publish(partition('202001'), partition('202002'), partition('202001', 'klines'));

    expect(await states({ dataset: 'klines' })).toEqual(['klines 202001 away']);
    expect(await states({ dataset: 'trades', from: '202002', to: '202002' })).toEqual(['trades 202002 away']);
  });
});

describe('what is asked', () => {
  const found = (...list: Pullable['state'][]): Pullable[] =>
    list.map((state, at) => ({ state, held: { ...partition(`20200${at + 1}`), tarId: 1, next: null } }));

  /** `--yes` is the answer a question has by itself: over what differs, and not again what is the same. */
  it('takes each question\'s own answer where every answer was given beforehand', async () => {
    setYes(true);

    expect((await chosen(found('away', 'same', 'differs', 'old'), false)).map(one => one.state)).toEqual(['away', 'old', 'differs']);
  });

  it('brings back everything that is on disk already where it is forced', async () => {
    expect((await chosen(found('away', 'same', 'differs'), true)).map(one => one.state)).toEqual(['away', 'same', 'differs']);
  });
});

describe('a tar brought back', () => {
  it('puts what was asked for in the archives, and nothing else of the tar', async () => {
    const wanted = partition('202001');
    const beside = partition('202001', 'klines');

    store(wanted, beside);
    publish(wanted, beside);

    const mega = remote();

    expect(await pull(await look({ dataset: 'trades' }), mega)).toBe(0);

    expect(mega.asked).toEqual(['/x/gate/t1.tar']);
    expect(fs.readFileSync(path.join(dir, 'archives', fileOf(wanted)), 'utf8')).toBe('aa');
    expect(fs.existsSync(path.join(dir, 'archives', fileOf(beside)))).toBe(false);

    // Nothing of the tar is left beside the archives.
    expect(fs.readdirSync(path.join(dir, 'cold', 'pulling', 'archives', 'gate'))).toEqual([]);
  });

  /** Over what is there, and nothing removed: a file the tar does not hold stays. */
  it('writes over a file that differs, and leaves alone one it does not hold', async () => {
    const one = partition('202001');

    store(one);
    publish(one);
    onDisk(one, 'changed');

    const stray = path.join(dir, 'archives', path.dirname(fileOf(one)), 'stray.txt');

    fs.writeFileSync(stray, 'mine');

    await pull(await look());

    expect(fs.readFileSync(path.join(dir, 'archives', fileOf(one)), 'utf8')).toBe('aa');
    expect(fs.readFileSync(stray, 'utf8')).toBe('mine');
  });

  /** Something to look at, and nothing to stock from. */
  it('puts a version the catalog has moved on from beside the archives, never in them', async () => {
    const one = partition('202001');

    store(one);
    publish({ ...one, version: 'v2' });

    await pull(await look());

    expect(fs.existsSync(path.join(dir, 'archives', fileOf(one)))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'cold', 'pulled', 'archives', fileOf(one)), 'utf8')).toBe('aa');
  });

  it('is no longer a partition taken off the disk', async () => {
    const one = partition('202001');

    store(one);
    publish(one);
    record.noteEviction(db, 'archives', one, { files: 1, bytes: 2 });

    await pull(await look());

    expect(record.evictedOf(db, 'archives', 'gate').size).toBe(0);

    // What happened is still on record: it went, and it came back.
    expect(db.prepare('SELECT count(*) AS n, count(returned_at) AS back FROM eviction').get()).toEqual({ n: 1, back: 1 });
  });

  it('counts a tar that never comes, and carries on', async () => {
    store(partition('202001'));
    publish(partition('202001'));

    const gone: Fetching = { downloadingPaths: async () => new Set<string>(), queueDownload: async () => {} };

    expect(await pull(await look(), gone as Fetching & { asked: string[] })).toBe(1);
  });
});
