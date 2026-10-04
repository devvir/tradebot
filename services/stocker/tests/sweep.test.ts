import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import config from '../src/config';
import { open } from '../src/db';
import { parseKey } from '../src/keys';
import { sweep } from '../src/scan';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { ListedSlice } from '../src/types';

/**
 * Whole sweeps, against a fake archives tree and a catalog answered by a stub:
 * what gets stocked and in which form, what reads as current, what restocks,
 * what waits.
 */

const FIXTURES = join(__dirname, 'fixtures');
const MONTH    = '202606';
const SLICE    = join('venue=gate', 'market=perp', 'dataset=trades');

interface Listed { Key: string; ETag: string; Size: number }

let conns: DuckDBConnection[];
let close: () => void;
let listed: Listed[];
let pending: string[];

/** When the catalog last saw anything change: long ago, unless a test says otherwise. */
let updatedAt: string;

/** What each request to the catalog asked for. */
let queries: URLSearchParams[];

const key = (symbol: string, date = MONTH) =>
  `gate/perp/trades/B/${symbol}/${date.slice(0, 6)}/gate|perp|trades|${symbol}|${date}.csv.gz`;

/** Put a fixture in the archives under a key, gzipped, and catalogue it. */
const place = async (fixture: string, at: string, etag = 'e1'): Promise<void> => {
  const path = join(config.archivesDir, at);

  await mkdir(dirname(path), { recursive: true });
  execFileSync('bash', ['-c', `gzip -c ${JSON.stringify(join(FIXTURES, fixture))} > ${JSON.stringify(path)}`]);

  listed.push({ Key: at, ETag: `"${etag}"`, Size: (await stat(path)).size });
};

/**
 * The catalog's partitions of a venue, folded from `listed` and `pending` the
 * way the catalog keeps them: counts, bytes, and a version that moves with any
 * file's ETag — narrowed, as the catalog narrows them, to what was asked for.
 */
const catalog = async (url: string | URL): Promise<Response> => {
  const venue  = /\/venues\/([^/?]+)\/partitions/.exec(String(url))?.[1];
  const asked  = new URL(String(url)).searchParams;

  queries.push(asked);

  const slices = new Map<string, ListedSlice>();
  const tags   = new Map<string, string[]>();

  for (const one of listed) {
    const file = parseKey(one.Key)!;

    if (file.venue !== venue) continue;

    const id    = [file.market, file.dataset, file.variant, file.grain, file.bundle].join('|');
    const month = file.month.replace('-', '');
    const slice = slices.get(id) ?? {
      market: file.market, dataset: file.dataset, variant: file.variant,
      grain: file.grain, bundle: file.bundle, partitions: [],
    };

    let held = slice.partitions.find(each => each.month === month);

    if (! held) {
      held = { month, files: 0, bytes: 0, pending: 0, pendingBytes: 0, withdrawn: 0, version: '', updatedAt };
      slice.partitions.push(held);
    }

    held.files++;
    held.bytes += one.Size;

    if (pending.includes(one.Key)) held.pending++;

    tags.set(`${id}|${month}`, [...tags.get(`${id}|${month}`) ?? [], one.ETag]);
    held.version = createHash('sha256').update(tags.get(`${id}|${month}`)!.join()).digest('hex').slice(0, 16);

    slices.set(id, slice);
  }

  const before = asked.get('settled-before');
  const wanted = asked.get('datasets')?.split(',');

  const items = [...slices.values()]
    .filter(slice => ! wanted || wanted.includes(slice.dataset))
    .map(slice => ({ ...slice, partitions: slice.partitions.filter(one =>
      (asked.get('downloaded') !== 'true' || one.pending === 0) && (! before || one.updatedAt < before)) }))
    .filter(slice => slice.partitions.length > 0);

  return new Response(JSON.stringify({ items }), { status: 200 });
};

/** Every file of the slice in the vault, relative to it. */
const stocked = async (): Promise<string[]> =>
  ((await readdir(join(config.vaultDir, SLICE), { recursive: true }).catch(() => [])) as string[])
    .filter(name => /\.(parquet|publishing)$/.test(name)).sort();

const rowsOf = async (path: string): Promise<unknown[][]> =>
  (await conns[0]!.runAndReadAll(`SELECT symbol, count(*)::INT FROM read_parquet('${path}') GROUP BY 1 ORDER BY 1`)).getRows();

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(catalog));
  ({ conns, close } = await open());
});

afterAll(async () => {
  close();
  vi.unstubAllGlobals();
  await rm(config.archivesDir, { recursive: true, force: true });
  await rm(config.vaultDir, { recursive: true, force: true });
});

beforeEach(async () => {
  listed    = [];
  pending   = [];
  queries   = [];
  updatedAt = '2020-01-01T00:00:00.000Z';

  await rm(config.archivesDir, { recursive: true, force: true });
  await rm(config.vaultDir, { recursive: true, force: true });
  await mkdir(config.vaultDir, { recursive: true });
});

describe('a sweep', () => {
  it('stocks a complete partition as one file holding every instrument', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    await place('gate.futures_btc-trades.csv', key('BTC_USD'));

    const summary = await sweep(conns);

    expect(summary).toMatchObject({ built: 1, failed: 0, files: 2 });

    const [file, ...rest] = await stocked();

    expect(rest).toEqual([]);
    expect(file).toMatch(/^@\/202606\.[0-9a-f]{12}\.parquet$/);

    // Each row says whose it is, and the instruments follow one another.
    const rows = await rowsOf(join(config.vaultDir, SLICE, file!));

    expect(rows.map(row => row[0])).toEqual(['BTC_USD', 'BTC_USDT']);
  });

  it('finds it current the next time, and reads nothing', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));

    await sweep(conns);

    expect(await sweep(conns)).toMatchObject({ built: 0, current: 1 });
  });

  /** Whatever changes in the catalog changes the revision, and the old one goes. */
  it('restocks when a file changes in the catalog, and keeps only the new revision', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    await sweep(conns);

    const before = await stocked();

    listed[0]!.ETag = '"e2"';

    expect(await sweep(conns)).toMatchObject({ built: 1 });

    const after = await stocked();

    expect(after).toHaveLength(1);
    expect(after).not.toEqual(before);
  });

  /** The catalog is asked only for what can be acted on, and only for what stocker reads. */
  it('asks for partitions that are downloaded and have gone quiet', async () => {
    await sweep(conns);

    const [asked] = queries;
    const quiet   = Date.now() - new Date(asked!.get('settled-before')!).getTime();

    expect(asked!.get('downloaded')).toBe('true');
    expect(Math.round(quiet / 3_600_000)).toBe(config.coolHours);
    expect(asked!.get('datasets')!.split(',')).toContain('trades');
  });

  it('leaves a partition alone while any file of it is still owed', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    pending = [key('BTC_USDT')];

    expect(await sweep(conns)).toMatchObject({ built: 0, considered: 0 });
    expect(await stocked()).toEqual([]);
  });

  /** A partition a run may still be adding to is left alone until it has gone quiet. */
  it('leaves a partition that changed too recently for a later sweep', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    updatedAt = new Date().toISOString();

    expect(await sweep(conns)).toMatchObject({ built: 0, considered: 0 });

    updatedAt = new Date(Date.now() - 2 * config.coolHours * 3_600_000).toISOString();

    expect(await sweep(conns)).toMatchObject({ built: 1 });
  });

  it('skips a partition that is not on disk as catalogued', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    listed.push({ Key: key('ETH_USDT'), ETag: '"x"', Size: 10 });

    expect(await sweep(conns)).toMatchObject({ built: 0, missing: 1 });
  });

  /** The preferred rendering missing from disk is no reason to stock nothing. */
  it('falls back to another rendering that is on disk', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT', '20260601'));
    listed.push({ Key: key('BTC_USDT'), ETag: '"m"', Size: 10 });

    expect(await sweep(conns)).toMatchObject({ built: 1, missing: 0 });
  });
});

/**
 * A month whose archive files weigh more than the threshold is stored as a
 * file per instrument, so one instrument's share can be handled on its own.
 */
describe('a partition over the split size', () => {
  const was = config.splitGb;

  beforeEach(() => { config.splitGb = 1e-9; });
  afterEach(() => { config.splitGb = was; });

  it('is stored as a file per instrument, each under its symbol', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    await place('gate.futures_btc-trades.csv', key('BTC_USD'));

    expect(await sweep(conns)).toMatchObject({ built: 1, files: 2 });

    const files = await stocked();

    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^BTC_USD\/202606\.[0-9a-f]{12}\.parquet$/);
    expect(files[1]).toMatch(/^BTC_USDT\/202606\.[0-9a-f]{12}\.parquet$/);

    // The symbol is a column there too, so both forms read as one table.
    expect((await rowsOf(join(config.vaultDir, SLICE, files[0]!))).map(row => row[0])).toEqual(['BTC_USD']);
    expect(await sweep(conns)).toMatchObject({ built: 0, current: 1 });
  });

  /** A publish something interrupted left its marker behind, and is done again. */
  it('does not take an interrupted publish for a stocked partition', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    await sweep(conns);

    const [file] = await stocked();
    const revision = file!.split('.')[1]!;

    await mkdir(join(config.vaultDir, SLICE, '@'), { recursive: true });
    await writeFile(join(config.vaultDir, SLICE, '@', `${MONTH}.${revision}.publishing`), '');

    expect(await sweep(conns)).toMatchObject({ built: 1, current: 0 });
    expect(await stocked()).toEqual([file]);
  });

  /** A month that grew past the threshold changes form with its revision; the old form goes. */
  it('replaces a month stored whole when it comes back over the size', async () => {
    config.splitGb = was;

    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    await sweep(conns);

    expect((await stocked())[0]).toMatch(/^@\//);

    config.splitGb = 1e-9;
    listed[0]!.ETag = '"e2"';

    expect(await sweep(conns)).toMatchObject({ built: 1 });
    expect(await stocked()).toHaveLength(1);
    expect((await stocked())[0]).toMatch(/^BTC_USDT\//);
  });
});

describe('a sweep below the space floor', () => {
  /** Nothing can be stocked, so the catalog is not even asked. */
  it('stops before asking anything', async () => {
    const floor = config.minFreeGb;

    config.minFreeGb = 1e9;
    vi.mocked(fetch).mockClear();

    try {
      expect(await sweep(conns)).toMatchObject({ stopped: true, considered: 0 });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      config.minFreeGb = floor;
    }
  });
});
