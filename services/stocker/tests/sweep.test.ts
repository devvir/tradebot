import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@devvir/service-kit';
import config from '../src/config';
import { SCRATCH } from '../src/containers';
import { open } from '../src/db';
import { Scans, drain } from '../src/drain';
import { parseKey } from '../src/keys';
import { BACKEDUP, ERRORS, LEDGER, outdate, read, reinstate, validate } from '../src/ledger';
import * as build from '../src/build';
import { Prefetch, _test_held as held } from '../src/prepare';
import * as disk from '../src/disk';
import * as room from '../src/room';
import * as vault from '../src/vault';
import { _test_aloneAt as aloneAt, sweep } from '../src/scan';
import { _test_splitAt as splitAt } from '../src/stock';
import { _test_directAt as directAt, _test_pieceAt as pieceAt } from '../src/tasks';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { ListedSlice, Summary } from '../src/types';

/** The real `rm` throughout, so a test can make one removal fail. */
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();

  return { ...real, rm: vi.fn(real.rm) };
});

/**
 * Whole sweeps, against a fake archives tree and a catalog answered by a stub:
 * what gets stocked and in which form, what reads as current, what restocks,
 * what waits.
 */

const FIXTURES = join(__dirname, 'fixtures');
const MONTH    = '202606';
const SLICE    = join('venue=gate', 'market=perp', 'dataset=trades', 'aggregated=false');

interface Listed { Key: string; ETag: string; Size: number }

let conns: DuckDBConnection[];
let close: () => void;
let listed: Listed[];
let pending: string[];

/** When the catalog last saw anything change: long ago, unless a test says otherwise. */
let updatedAt: string;

/** What each request to the catalog asked for, and of which venue. */
let queries: URLSearchParams[];
let venuesAsked: string[];

/** Venues the catalog answers 404 for. */
let refused: string[];

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
  venuesAsked.push(venue ?? '');

  if (refused.includes(venue ?? '')) return new Response(JSON.stringify({ error: 'No such venue' }), { status: 404 });

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

  // The catalog's own settled rule is its business; here it is whatever went quiet in time.
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
    .filter(name => name.endsWith('.parquet')).sort();

/** A file of the vault's as its lines, each by its heading. */
const linesOf = async (name: string): Promise<Record<string, string>[]> => {
  const [head, ...rest] = (await readFile(join(config.vaultDir, name), 'utf8')).trim().split('\n');

  return rest.map(line => Object.fromEntries(line.split('|').map((field, at) => [head!.split('|')[at]!, field])));
};

/**
 * Leave the ledger as it is when something stops a partition between the first
 * file moving and the last: its last line again, saying `updating`, changed as
 * the test says.
 */
const interrupt = async (change: Record<string, string> = {}): Promise<void> => {
  const text = await readFile(join(config.vaultDir, LEDGER), 'utf8');
  const [head, ...rest] = text.trim().split('\n');
  const columns = head!.split('|');
  const last    = rest.at(-1)!.split('|');
  const line: Record<string, string> = { ...Object.fromEntries(columns.map((name, at) => [name, last[at]!])), revision: 'updating', ...change };

  await appendFile(join(config.vaultDir, LEDGER), `${columns.map(name => line[name]).join('|')}\n`);
};

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
  venuesAsked = [];
  refused   = [];
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
    expect(file).toBe('@/202606.parquet');

    // Each row says whose it is, and the instruments follow one another.
    const rows = await rowsOf(join(config.vaultDir, SLICE, file!));

    expect(rows.map(row => row[0])).toEqual(['BTC_USD', 'BTC_USDT']);
  });

  it('finds it current the next time, and reads nothing', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));

    await sweep(conns);

    expect(await sweep(conns)).toMatchObject({ built: 0, current: 1 });
  });

  /** Whatever changes in the catalog changes the revision, and the month is written where it was. */
  it('restocks when a file changes in the catalog, over the month that was there', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    await sweep(conns);

    const before = await stocked();
    const [was]  = await linesOf(LEDGER);

    listed[0]!.ETag = '"e2"';

    expect(await sweep(conns)).toMatchObject({ built: 1 });
    expect(await stocked()).toEqual(before);

    // The ledger is what tells the two apart: it said the month was outdated, then changing, then what it holds.
    const [, stale, changing, now] = await linesOf(LEDGER);

    expect(stale!['revision']).toBe('outdated');
    expect(changing!['revision']).toBe('updating');
    expect(now!['revision']).toMatch(/^[0-9a-f]{12}$/);
    expect(now!['revision']).not.toBe(was!['revision']);
  });

  /** Its archives changed and are not on disk: nothing to stock it from, so it says what it is and keeps its files. */
  it('marks a stocked partition outdated, once, where it cannot be stocked again', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    await sweep(conns);

    const before = await stocked();

    listed[0]!.ETag = '"e2"';
    await rm(join(config.archivesDir, key('BTC_USDT')));

    expect(await sweep(conns)).toMatchObject({ built: 0, current: 0, missing: 1, outdated: 1 });
    expect(await sweep(conns)).toMatchObject({ built: 0, current: 0, missing: 1, outdated: 1 });
    expect(await stocked()).toEqual(before);
    expect((await linesOf(LEDGER)).map(line => line['revision'])).toEqual([expect.stringMatching(/^[0-9a-f]{12}$/), 'outdated']);

    // Its files are whole, so it is nothing for a start to report.
    expect(await validate()).toBe(0);
  });

  it('stocks an outdated partition again once its archives are back', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    await sweep(conns);

    listed[0]!.ETag = '"e2"';
    await rm(join(config.archivesDir, key('BTC_USDT')));
    await sweep(conns);

    listed = [];
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'), 'e2');

    expect(await sweep(conns)).toMatchObject({ built: 1, outdated: 0 });
    expect(await sweep(conns)).toMatchObject({ built: 0, current: 1 });
    expect((await linesOf(LEDGER)).at(-1)!['revision']).toMatch(/^[0-9a-f]{12}$/);
  });

  /** What made it outdated was taken back: its files are what would be stocked, and the ledger says so again. */
  it('takes an outdated partition as current again where its revision is the one computed', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    await sweep(conns);

    const [was] = await linesOf(LEDGER);

    listed[0]!.ETag = '"e2"';
    await rm(join(config.archivesDir, key('BTC_USDT')));
    await sweep(conns);

    listed[0]!.ETag = '"e1"';

    expect(await sweep(conns)).toMatchObject({ built: 0, current: 1, outdated: 0 });
    expect((await linesOf(LEDGER)).at(-1)!['revision']).toBe(was!['revision']);
  });

  /** Stopped between the first file and the last: some of one build, some of another, and nothing to tell them apart. */
  it('stocks again a partition something stopped while its files were replaced', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    await sweep(conns);
    await interrupt();

    expect(await sweep(conns)).toMatchObject({ built: 1, current: 0 });
    expect(await stocked()).toEqual(['@/202606.parquet']);
    expect((await linesOf(LEDGER)).at(-1)!['revision']).toMatch(/^[0-9a-f]{12}$/);
    expect(await sweep(conns)).toMatchObject({ built: 0, current: 1 });
  });

  /** Its archives have gone, so there is nothing to stock it from — and what is left of it is still not a month. */
  it('holds nothing of a partition stopped half way, until it can be stocked again', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    await sweep(conns);
    await interrupt();
    await rm(join(config.archivesDir, key('BTC_USDT')));

    expect(await sweep(conns)).toMatchObject({ built: 0, current: 0, missing: 1 });
    expect(await stocked()).toEqual([]);
  });

  /** The catalog is asked only for what can be acted on, and only for what stocker reads. */
  it('asks for partitions that are downloaded and settled', async () => {
    await sweep(conns);

    const [asked] = queries;

    expect(asked!.get('downloaded')).toBe('true');
    expect(asked!.get('settled')).toBe('true');
    expect(asked!.has('settled-before')).toBe(false);
    expect(asked!.get('datasets')!.split(',')).toContain('trades');
  });

  /** The setting says which venues, and nothing of the order they are taken in. */
  it('works through the venues alphabetically, whatever order they were named in', async () => {
    const all = config.venues;

    config.venues = ['okx', 'gate', 'bybit'];

    try {
      await sweep(conns);
    } finally {
      config.venues = all;
    }

    expect(venuesAsked).toEqual(['bybit', 'gate', 'okx']);
  });

  it('leaves a partition alone while any file of it is still owed', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    pending = [key('BTC_USDT')];

    expect(await sweep(conns)).toMatchObject({ built: 0, considered: 0 });
    expect(await stocked()).toEqual([]);
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
  beforeEach(() => { splitAt(1); });
  afterEach(() => { splitAt(null); });

  it('is stored as a file per instrument, each under its symbol', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    await place('gate.futures_btc-trades.csv', key('BTC_USD'));

    expect(await sweep(conns)).toMatchObject({ built: 1, files: 2 });

    const files = await stocked();

    expect(files).toHaveLength(2);
    expect(files).toEqual(['BTC_USD/202606.parquet', 'BTC_USDT/202606.parquet']);

    // The symbol is a column there too, so both forms read as one table.
    expect((await rowsOf(join(config.vaultDir, SLICE, files[0]!))).map(row => row[0])).toEqual(['BTC_USD']);
    expect(await sweep(conns)).toMatchObject({ built: 0, current: 1 });
  });

  /**
   * With a safe copy elsewhere, whatever of a partition is here is fine: all of
   * its files, some of them, or none.
   */
  it('is nothing to report with some of its files away, where it has a safe copy', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    await place('gate.futures_btc-trades.csv', key('BTC_USD'));
    await sweep(conns);

    const [gone]         = await stocked();
    const [{ revision }] = await linesOf(LEDGER) as [Record<string, string>];

    await rm(join(config.vaultDir, SLICE, gone!));

    expect(await validate()).toBe(1);

    await rm(join(config.vaultDir, ERRORS));
    await writeFile(join(config.vaultDir, BACKEDUP),
      `partition|revision|date\n${SLICE}/${MONTH}|${revision}|2026-10-06T00:00:00.000Z\n`);

    expect(await validate()).toBe(0);
    expect(await stocked()).toHaveLength(1);
  });

  /** Some instruments' files in place and some not, when something stopped it: none of them is kept. */
  it('does not take a month stopped half way through its files for a stocked partition', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    await place('gate.futures_btc-trades.csv', key('BTC_USD'));
    await sweep(conns);
    await interrupt();
    await rm(join(config.vaultDir, SLICE, 'BTC_USD', '202606.parquet'));

    expect(await validate()).toBe(0);
    expect(await stocked()).toEqual([]);

    expect(await sweep(conns)).toMatchObject({ built: 1, current: 0 });
    expect(await stocked()).toEqual(['BTC_USD/202606.parquet', 'BTC_USDT/202606.parquet']);
  });

  /** A month that grew past the threshold changes form with its revision; the old form goes. */
  it('replaces a month stored whole when it comes back over the size', async () => {
    splitAt(null);

    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    await sweep(conns);

    expect((await stocked())[0]).toMatch(/^@\//);

    splitAt(1);
    listed[0]!.ETag = '"e2"';

    expect(await sweep(conns)).toMatchObject({ built: 1 });
    expect(await stocked()).toHaveLength(1);
    expect((await stocked())[0]).toMatch(/^BTC_USDT\//);
  });
});

/**
 * A venue that cuts its periods away from UTC midnight: a month's last hours
 * sit in a file of the month after. They are stocked beside the month and not
 * into it, and a month whose neighbour is not there is stocked without them.
 */
describe('a month whose last hours are in the next month\'s file', () => {
  /** bybit's MT4 klines: a file is a UTC+3 month, so it opens with the last three hours of the UTC month before. */
  const KLINES = join('venue=bybit', 'market=perp', 'dataset=klines', 'interval=1h');

  const month = (at: string, symbol = 'BTCUSDT'): string =>
    `bybit/perp/klines,1h/B/${symbol}/${at}/bybit|perp|klines,1h|${symbol}|${at}.csv.gz`;

  /** A file of rows written by hand: stamped in UTC+3, as the venue stamps them. */
  const publish = async (at: string, rows: string[], etag = 'e1', symbol = 'BTCUSDT'): Promise<void> => {
    const path = join(config.archivesDir, month(at, symbol));

    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.txt`, rows.join('\n') + '\n');
    execFileSync('bash', ['-c', `gzip -c ${JSON.stringify(`${path}.txt`)} > ${JSON.stringify(path)}`]);
    await rm(`${path}.txt`);

    listed.push({ Key: month(at, symbol), ETag: `"${etag}"`, Size: (await stat(path)).size });
  };

  /** Say the vault has a safe copy of a month at the revision its last line names. */
  const backUp = async (line: Record<string, string>): Promise<void> =>
    writeFile(join(config.vaultDir, BACKEDUP), `partition|revision|date\n${line['partition']}|${line['revision']}|T\n`);

  const NOVEMBER = [
    '2024.11.01 00:00,1,1,1,1,10',   // 31 October 21:00 UTC: October's, and not kept here
    '2024.11.01 03:00,2,2,2,2,20',   // 1 November 00:00 UTC
    '2024.11.15 00:00,3,3,3,3,30',
  ];

  const DECEMBER = [
    '2024.12.01 00:00,4,4,4,4,40',   // 30 November 21:00 UTC: November's last hours
    '2024.12.01 02:00,5,5,5,5,50',   // 30 November 23:00 UTC
    '2024.12.01 05:00,6,6,6,6,60',   // 1 December 02:00 UTC
  ];

  const files = async (): Promise<string[]> =>
    ((await readdir(join(config.vaultDir, KLINES), { recursive: true }).catch(() => [])) as string[])
      .filter(name => name.endsWith('.parquet')).sort();

  const closes = async (file: string): Promise<number[]> =>
    (await conns[0]!.runAndReadAll(`SELECT close FROM read_parquet('${join(config.vaultDir, KLINES, file)}') ORDER BY ts`))
      .getRows().map(row => Number(row[0]));

  const lines = async (): Promise<Record<string, string>[]> => {
    const [head, ...rest] = (await readFile(join(config.vaultDir, LEDGER), 'utf8')).trim().split('\n');

    return rest.map(line => Object.fromEntries(line.split('|').map((field, at) => [head!.split('|')[at]!, field])));
  };

  it('is stocked without them where the next month is not there, and says so', async () => {
    await publish('202411', NOVEMBER);

    expect(await sweep(conns)).toMatchObject({ built: 1, partial: 1, waiting: 0 });

    const [only, ...rest] = await files();

    expect(rest).toEqual([]);
    expect(only).toBe('@/202411.parquet');
    expect(await closes(only!)).toEqual([2, 3]);
    expect(await lines()).toMatchObject([{ month: '202411', preVersion: '', postVersion: 'missing', count: '1' }]);
  });

  it('is current as it is, sweep after sweep, while the next month stays away', async () => {
    await publish('202411', NOVEMBER);
    await sweep(conns);

    expect(await sweep(conns)).toMatchObject({ built: 0, completed: 0, current: 1, partial: 1 });
  });

  /** The month's own rows are in the vault and unchanged: only the hours the neighbour holds are built. */
  it('is given them when the next month arrives, as a file of their own, without its own archives', async () => {
    await publish('202411', NOVEMBER);
    await sweep(conns);

    const written = (await stat(join(config.vaultDir, KLINES, '@/202411.parquet'))).mtimeMs;

    // November's archives have left the disk; the catalog still says they are downloaded.
    await rm(join(config.archivesDir, month('202411')));
    await publish('202412', DECEMBER);

    expect(await sweep(conns)).toMatchObject({ completed: 1, built: 1, failed: 0 });

    const november = (await files()).filter(name => name.includes('202411'));

    expect(november).toEqual(['@/202411.parquet', '@/202411.post.parquet']);

    // Its own file is the one that was there: nothing wrote to it.
    expect((await stat(join(config.vaultDir, KLINES, '@/202411.parquet'))).mtimeMs).toBe(written);

    expect(await closes(november[0]!)).toEqual([2, 3]);
    expect(await closes(november[1]!)).toEqual([4, 5]);

    const ledger = (await lines()).filter(one => one['month'] === '202411');

    expect(ledger.map(one => one['revision'])).toEqual([expect.stringMatching(/^[0-9a-f]{12}$/), 'updating-sides', expect.stringMatching(/^[0-9a-f]{12}$/)]);
    expect(ledger[2]!['postVersion']).toMatch(/^[0-9a-f]{16}$/);
    expect(ledger[2]!['count']).toBe('2');
    expect(await validate()).toBe(0);
  });

  /** Its own file was never touched, so it goes back to what it was: stocked, and without those hours. */
  it('is still stocked where something stopped it while those hours were added', async () => {
    await publish('202411', NOVEMBER);
    await sweep(conns);

    const own = join(config.vaultDir, KLINES, '@/202411.parquet');
    const [partial] = await lines();

    await interrupt({ revision: 'updating-sides', postVersion: '0123456789abcdef' });
    await writeFile(own.replace('.parquet', '.post.parquet'), 'half written');

    expect(await sweep(conns)).toMatchObject({ built: 0, current: 1, partial: 1 });
    expect(await files()).toEqual(['@/202411.parquet']);
    expect((await lines()).at(-1)).toEqual(partial);
    expect(await validate()).toBe(0);

    // And the hours are added as they would have been.
    await rm(join(config.archivesDir, month('202411')));
    await publish('202412', DECEMBER);

    expect(await sweep(conns)).toMatchObject({ completed: 1, failed: 0 });
    expect(await closes('@/202411.post.parquet')).toEqual([4, 5]);
  });

  /**
   * The same two lines, but a month that was being stocked again from its own
   * archives: its own file may be of the build arriving, so none of it is kept.
   */
  it('is no longer stocked where something stopped it while it was stocked again', async () => {
    await publish('202411', NOVEMBER);
    await sweep(conns);

    const before = await lines();

    await interrupt({ postVersion: '0123456789abcdef' });
    await writeFile(join(config.vaultDir, KLINES, '@/202411.post.parquet'), 'half written');

    expect(await validate()).toBe(0);
    expect(await files()).toEqual([]);
    expect((await lines()).slice(0, before.length)).toEqual(before);
    expect((await lines()).at(-1)!['revision']).toBe('updating');

    expect(await sweep(conns)).toMatchObject({ built: 1, current: 0 });
    expect(await files()).toEqual(['@/202411.parquet']);
  });

  /** Its own file was moved out of the vault, and its archives are still here: it waits all the same, and is not stocked again. */
  it('waits for its own file where that is not in the vault, whatever of its archives is on disk', async () => {
    await publish('202411', NOVEMBER);
    await sweep(conns);

    const [line] = await lines();

    await backUp(line!);
    await rm(join(config.vaultDir, KLINES, '@/202411.parquet'));
    await publish('202412', DECEMBER);

    // December is stocked, itself without its last hours; November waits.
    expect(await sweep(conns)).toMatchObject({ built: 1, completed: 0, partial: 2, failed: 0 });
    expect((await files()).filter(name => name.includes('202411'))).toEqual([]);
    expect((await lines()).filter(one => one['month'] === '202411')).toEqual([line]);
  });

  /**
   * Stored a file per instrument, with one instrument's file moved out of the
   * vault: its hours would be left out of the side, so the month waits for it.
   */
  it('waits for every instrument of its own where some are not in the vault', async () => {
    splitAt(0);

    try {
      await publish('202411', NOVEMBER, 'e1', 'AAAUSDT');
      await publish('202411', NOVEMBER, 'e1', 'BBBUSDT');
      await sweep(conns);

      expect(await files()).toEqual(['AAAUSDT/202411.parquet', 'BBBUSDT/202411.parquet']);

      const [line] = await lines();
      const own    = join(config.vaultDir, KLINES, 'AAAUSDT/202411.parquet');
      const away   = join(config.archivesDir, 'away.parquet');

      await backUp(line!);
      await mkdir(config.archivesDir, { recursive: true });
      await rename(own, away);
      await rm(join(config.archivesDir, month('202411', 'AAAUSDT')));
      await rm(join(config.archivesDir, month('202411', 'BBBUSDT')));
      await publish('202412', DECEMBER, 'e1', 'AAAUSDT');
      await publish('202412', DECEMBER, 'e1', 'BBBUSDT');

      const warned = vi.spyOn(logger, 'warn');

      expect(await sweep(conns)).toMatchObject({ built: 1, completed: 0, partial: 2, failed: 0 });
      expect(warned.mock.calls.some(call => call[1] === 'Spill pending')).toBe(true);

      warned.mockRestore();

      expect((await files()).filter(name => name.includes('202411'))).toEqual(['BBBUSDT/202411.parquet']);
      expect((await lines()).filter(one => one['month'] === '202411')).toEqual([line]);

      // Back in the vault, the month is given both instruments' hours.
      await rename(away, own);

      expect(await sweep(conns)).toMatchObject({ completed: 1, failed: 0 });
      expect((await files()).filter(name => name.includes('202411'))).toEqual([
        'AAAUSDT/202411.parquet', 'AAAUSDT/202411.post.parquet', 'BBBUSDT/202411.parquet', 'BBBUSDT/202411.post.parquet',
      ]);
      expect(await closes('AAAUSDT/202411.post.parquet')).toEqual([4, 5]);
      expect(await validate()).toBe(0);
    }
    finally {
      splitAt(null);
    }
  });

  /**
   * A venue's month file can carry the first bar of the next month, which the
   * next month's file opens with too. A bar is kept once, in the month's own
   * file — whether the neighbour was there when the month was stocked or came later.
   */
  it('leaves out of those hours a bar the month\'s own file already holds', async () => {
    const REACHING = [...NOVEMBER, '2024.12.01 00:00,4,4,4,4,40'];   // 30 November 21:00 UTC, as December's file has it

    await publish('202411', REACHING);
    await sweep(conns);

    expect(await closes('@/202411.parquet')).toEqual([2, 3, 4]);

    await rm(join(config.archivesDir, month('202411')));
    await publish('202412', DECEMBER);

    expect(await sweep(conns)).toMatchObject({ completed: 1, failed: 0 });
    expect(await closes('@/202411.parquet')).toEqual([2, 3, 4]);
    expect(await closes('@/202411.post.parquet')).toEqual([5]);

    // And stocked with its neighbour there from the start.
    await rm(config.vaultDir, { recursive: true, force: true });
    await mkdir(config.vaultDir, { recursive: true });

    listed.length = 0;

    await publish('202411', REACHING);
    await publish('202412', DECEMBER);

    expect(await sweep(conns)).toMatchObject({ built: 2, failed: 0 });
    expect(await closes('@/202411.parquet')).toEqual([2, 3, 4]);
    expect(await closes('@/202411.post.parquet')).toEqual([5]);
    expect(await validate()).toBe(0);
  });

  /** The same files whether the neighbour was there when the month was stocked or came later. */
  it('comes to the same files whichever way it got them', async () => {
    await publish('202411', NOVEMBER);
    await sweep(conns);
    await publish('202412', DECEMBER);
    await sweep(conns);

    const later = (await files()).filter(name => name.includes('202411'));

    await rm(config.vaultDir, { recursive: true, force: true });
    await mkdir(config.vaultDir, { recursive: true });

    expect(await sweep(conns)).toMatchObject({ built: 2, completed: 0 });

    const atOnce = (await files()).filter(name => name.includes('202411'));

    expect(atOnce).toEqual(later);
    expect(await closes(atOnce[0]!)).toEqual([2, 3]);
    expect(await closes(atOnce[1]!)).toEqual([4, 5]);
  });

  /** December is stocked from its own file, whose first hours are November's and are not December's. */
  it('keeps the next month\'s own rows to that month', async () => {
    await publish('202411', NOVEMBER);
    await publish('202412', DECEMBER);
    await sweep(conns);

    const [december] = (await files()).filter(name => name.includes('202412'));

    expect(await closes(december!)).toEqual([6]);
    expect((await lines()).find(one => one['month'] === '202412')).toMatchObject({ postVersion: 'missing' });
  });

  /** Anything but the neighbour arriving is a month to stock again from its own archives. */
  it('is stocked again, and not completed, where its own files changed', async () => {
    await publish('202411', NOVEMBER);
    await sweep(conns);

    listed[0]!.ETag = '"e2"';

    await publish('202412', DECEMBER);

    expect(await sweep(conns)).toMatchObject({ completed: 0, built: 2 });
    expect((await files()).filter(name => name.includes('202411'))).toHaveLength(2);
  });

  /** Its hours are built beside its own file, and that has been moved out of the vault: said for what it is. */
  it('waits for its own file where that is not in the vault, and is not taken for one whose archives are missing', async () => {
    await publish('202411', NOVEMBER);
    await sweep(conns);

    // Moved out of the vault, with a copy elsewhere — and its archives gone from the disk too.
    const [line] = await lines();

    await writeFile(join(config.vaultDir, BACKEDUP), `partition|revision|date\n${line!['partition']}|${line!['revision']}|T\n`);
    await rm(join(config.vaultDir, KLINES, '@/202411.parquet'));
    await rm(join(config.archivesDir, month('202411')));
    await publish('202412', DECEMBER);

    const warned = vi.spyOn(logger, 'warn');

    // December is stocked, itself without its last hours; November waits.
    expect(await sweep(conns)).toMatchObject({ built: 1, completed: 0, missing: 0, partial: 2, failed: 0 });

    const said = warned.mock.calls.find(call => call[1] === 'Spill pending');

    expect(said?.[0]).toMatchObject({
      'main parquet': 'backed up, not on disk',
      post:           'pending, needs main parquet',
      sources:        'post sources on disk',
    });

    warned.mockRestore();
  });

  it('is left as it is where it has to be stocked again and its own archives are gone', async () => {
    await publish('202411', NOVEMBER);
    await sweep(conns);

    const before = await files();

    listed[0]!.ETag = '"e2"';

    await rm(join(config.archivesDir, month('202411')));

    expect(await sweep(conns)).toMatchObject({ built: 0, completed: 0, missing: 1 });
    expect(await files()).toEqual(before);
  });
});

/**
 * The vault's own account of what it holds — what makes a partition current
 * without its slice being walked, and without its files being there.
 */
describe('the ledger', () => {
  const PARTITION = `${SLICE}/${MONTH}`;

  const lines = async (name: string): Promise<Record<string, string>[]> => {
    const [head, ...rest] = (await readFile(join(config.vaultDir, name), 'utf8')).trim().split('\n');

    return rest.map(line => Object.fromEntries(line.split('|').map((field, at) => [head!.split('|')[at]!, field])));
  };

  const there = (name: string): Promise<boolean> => stat(join(config.vaultDir, name)).then(() => true, () => false);

  beforeEach(async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    await sweep(conns);
  });

  it('gains a line for a partition stocked: what from, and what it weighed', async () => {
    const [file]  = await stocked();
    const [entry] = await lines(LEDGER);

    expect(entry).toMatchObject({
      partition: PARTITION, venue: 'gate', market: 'perp', dataset: 'trades', variant: '', grain: 'monthly',
      bundle: 'instrument', month: '202606', mode: 'bundle', preVersion: '', postVersion: '', count: '1',
      size: String((await stat(join(config.vaultDir, SLICE, file!))).size),
    });
    expect(entry!['version']).toMatch(/^[0-9a-f]{16}$/);
    expect(entry!['revision']).toMatch(/^[0-9a-f]{12}$/);
  });

  it('gains another when the partition is stocked again, and the last one counts', async () => {
    listed[0]!.ETag = '"e2"';

    await sweep(conns);

    const all = (await lines(LEDGER)).filter(one => ! ['updating', 'outdated'].includes(one['revision']!));

    expect(all).toHaveLength(2);
    expect(all[1]!['revision']).not.toBe(all[0]!['revision']);
    expect(await sweep(conns)).toMatchObject({ built: 0, current: 1 });
  });

  /** A partition moved out of the vault is still a partition stocked. */
  it('is taken at its word where the files are not there', async () => {
    await rm(join(config.vaultDir, SLICE), { recursive: true });

    expect(await sweep(conns)).toMatchObject({ built: 0, current: 1 });
    expect(await stocked()).toEqual([]);
  });

  /** A file says nothing of what it was built from, so one the ledger has no line for is nobody's word for anything. */
  it('stocks a partition it has no line for, whatever of it is in the vault', async () => {
    await rm(join(config.vaultDir, LEDGER));

    expect(await sweep(conns)).toMatchObject({ built: 1, current: 0 });
    expect(await stocked()).toHaveLength(1);
    expect((await lines(LEDGER)).at(-1)).toMatchObject({ partition: PARTITION, mode: 'bundle', count: '1' });
  });

  /** A write cut short leaves a tail that is not a line: it is never read, and the next line is not lost to it. */
  it('reads past a line cut short, and keeps the one written after it whole', async () => {
    const entry = (await read()).get(PARTITION)!;

    await outdate(entry);

    const whole = (await readFile(join(config.vaultDir, LEDGER), 'utf8')).trim().split('\n')[1]!;

    await appendFile(join(config.vaultDir, LEDGER), whole.replace(MONTH, '202607').slice(0, 70));
    await reinstate((await read()).get(PARTITION)!);

    const ledger = await read();

    expect([...ledger.keys()]).toEqual([PARTITION]);
    expect(ledger.get(PARTITION)).toEqual(entry);
  });

  it('starts an empty ledger with its heading, so its first line is read', async () => {
    await writeFile(join(config.vaultDir, LEDGER), '');

    expect(await sweep(conns)).toMatchObject({ built: 1, current: 0 });
    expect((await read()).get(PARTITION)).toMatchObject({ partition: PARTITION, mode: 'bundle', count: 1 });
    expect(await sweep(conns)).toMatchObject({ built: 0, current: 1 });
  });

  describe('set against the vault as the service starts', () => {
    it('finds nothing wrong with a vault that holds what it says', async () => {
      expect(await validate()).toBe(0);
      expect(await there(ERRORS)).toBe(false);
    });

    /** A loss: written where it cannot be missed, and stocked again. */
    it('reports a partition whose files have gone, and has it stocked again', async () => {
      await rm(join(config.vaultDir, SLICE), { recursive: true });

      expect(await validate()).toBe(1);
      expect(await readFile(join(config.vaultDir, ERRORS), 'utf8')).toMatch(
        new RegExp(`^\\d{4}-.*\\|${PARTITION}\\|[0-9a-f]{12}\\|its files are not in the vault\\n$`));

      expect(await sweep(conns)).toMatchObject({ built: 1, current: 0 });
      expect(await stocked()).toHaveLength(1);
    });

    it('says the same loss once, however often it is found', async () => {
      await rm(join(config.vaultDir, SLICE), { recursive: true });

      await validate();
      await validate();

      expect((await readFile(join(config.vaultDir, ERRORS), 'utf8')).trim().split('\n')).toHaveLength(1);
    });

    /** A safe copy exists, so nothing is lost whatever is here. */
    it('lets be a partition that has a safe copy at its revision', async () => {
      const [{ revision }] = await lines(LEDGER) as [Record<string, string>];

      await rm(join(config.vaultDir, SLICE), { recursive: true });
      await writeFile(join(config.vaultDir, BACKEDUP),
        `partition|revision|date\n${PARTITION}|${revision}|2026-10-06T00:00:00.000Z\n`);

      expect(await validate()).toBe(0);
      expect(await there(ERRORS)).toBe(false);
    });

    it('does not take a copy of another revision for one of this', async () => {
      await rm(join(config.vaultDir, SLICE), { recursive: true });
      await writeFile(join(config.vaultDir, BACKEDUP),
        `partition|revision|date\n${PARTITION}|000000000000|2026-10-06T00:00:00.000Z\n`);

      expect(await validate()).toBe(1);
    });

    /** A file that is there and is not the one that was stocked is rebuilt, never written down as it is. */
    it('reports a file that does not weigh what was stocked, and has it stocked again', async () => {
      const [file] = await stocked();

      await writeFile(join(config.vaultDir, SLICE, file!), 'not a parquet');

      expect(await validate()).toBe(1);
      expect(await readFile(join(config.vaultDir, ERRORS), 'utf8')).toMatch(/its files weigh 13 bytes where the ledger says \d+/);

      expect(await sweep(conns)).toMatchObject({ built: 1, current: 0 });
      expect(await validate()).toBe(0);
    });
  });
});

describe('scratch', () => {
  const scratch = (): string => join(config.vaultDir, SCRATCH);

  /** The engine spills with everything else transient, and no further than the volume's floor allows. */
  it('is where the engine spills, capped short of the space floor', async () => {
    const [[at, cap]] = (await conns[0]!.runAndReadAll(
      "SELECT current_setting('temp_directory'), current_setting('max_temp_directory_size')")).getRows() as [[string, string]];

    expect(at.startsWith(`${scratch()}/`)).toBe(true);
    expect(cap).not.toMatch(/%/);
  });

  /** What a hard kill leaves goes as the service starts — spill and all — but hours of pieces built stay. */
  it('is cleared of everything but the pieces that are built', async () => {
    const piece  = join(scratch(), 'stage', 'gate_perp.abc', 'own', build.PIECES, '0', '0');
    const legacy = join(config.vaultDir, '.duckdb-tmp');

    await mkdir(join(scratch(), 'engine'), { recursive: true });
    await writeFile(join(scratch(), 'engine', 'duckdb_temp_storage_x.tmp'), 'spill');
    await mkdir(join(scratch(), 'unpack-x'), { recursive: true });
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'duckdb_temp_storage_y.tmp'), 'spill');
    await mkdir(piece, { recursive: true });
    await writeFile(join(piece, 'BTC_USDT.parquet'), 'rows');
    await writeFile(join(piece, '.built'), '{}');

    await build.sweepScratch();

    expect(await readdir(scratch())).toEqual(['stage']);
    expect(await readdir(piece)).toEqual(expect.arrayContaining(['BTC_USDT.parquet', '.built']));
    expect(await stat(legacy).catch(() => null)).toBeNull();
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

/** One partition, or one venue, going wrong is no reason to stock nothing else. */
describe('a sweep that meets a failure', () => {
  const binance = (symbol: string, date: string) =>
    `binance/spot/trades/B/${symbol}/${date.slice(0, 6)}/binance|spot|trades|${symbol}|${date}.zip`;

  /** Put a fixture in the archives under a key, zipped, and catalogue it. */
  const zipped = async (fixture: string, at: string): Promise<void> => {
    const path = join(config.archivesDir, at);
    const dir  = join(config.archivesDir, '.zipping');

    await mkdir(dirname(path), { recursive: true });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'BTCUSDT-trades.csv'), await readFile(join(FIXTURES, fixture)));
    execFileSync('zip', ['-jq', path, join(dir, 'BTCUSDT-trades.csv')]);
    await rm(dir, { recursive: true, force: true });

    listed.push({ Key: at, ETag: '"z1"', Size: (await stat(path)).size });
  };

  /** A file the size of a busy day that is no zip at all, catalogued as it is. */
  const unreadable = async (at: string): Promise<void> => {
    const path = join(config.archivesDir, at);

    await mkdir(dirname(path), { recursive: true });
    execFileSync('truncate', ['-s', '17M', path]);

    listed.push({ Key: at, ETag: '"u1"', Size: (await stat(path)).size });
  };

  const logged = (fn: typeof logger.error): string[] => vi.mocked(fn).mock.calls.map(call => String(call[1]));

  beforeEach(() => vi.clearAllMocks());

  it('goes on to the next venue where the catalog refuses to list one', async () => {
    refused = ['binance'];

    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));

    expect(await sweep(conns)).toMatchObject({ built: 1, failed: 1 });
    expect(await stocked()).toEqual(['@/202606.parquet']);
    expect(logged(logger.error)).toContain('Catalog listing failed — venue skipped this sweep');
  });

  /** A big instrument's archives are opened to be weighed before anything is stocked; one that cannot be opened fails there. */
  it('goes on to the next partition where one cannot be decided', async () => {
    await unreadable(binance('BTCUSDT', '20200101'));
    await unreadable(binance('BTCUSDT', '20200102'));
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));

    const summary = await sweep(conns);

    expect(summary.failed).toBeGreaterThanOrEqual(1);
    expect(summary.built).toBe(1);
    expect(await stocked()).toEqual(['@/202606.parquet']);
    expect(vi.mocked(logger.error).mock.calls.find(call => call[1] === 'Deciding failed — partition skipped')?.[0])
      .toMatchObject({ partition: expect.stringContaining('binance') });
  });

  /** Outside its own handling, as in clearing staging before the build: the partition fails, and what was extracted for it goes. */
  it('fails a partition that stops where stocking it does not expect, and gives up what was extracted for it', async () => {
    const baseline = held();

    await zipped('binance.spot-trades.csv', binance('BTCUSDT', '202001'));
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));

    const kept = vi.spyOn(build, 'keepPieces').mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));

    try {
      expect(await sweep(conns)).toMatchObject({ built: 1, failed: 1 });
    } finally {
      kept.mockRestore();
    }

    expect(await stocked()).toEqual(['@/202606.parquet']);
    expect(logged(logger.error)).toContain('Stocking failed');
    await vi.waitFor(() => expect(held()).toBe(baseline));
  });

  /** Staging that cannot be cleared once a placement has failed: the partition has failed once, and is said to once. */
  it('counts a failed placement once where its staging cannot be cleared after it', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));

    const real    = build.keepPieces;
    const placing = vi.spyOn(vault, 'publishBundle').mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));
    const kept    = vi.spyOn(build, 'keepPieces')
      .mockImplementationOnce(real)
      .mockRejectedValueOnce(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));

    try {
      expect(await sweep(conns)).toMatchObject({ built: 0, failed: 1 });
      expect(kept).toHaveBeenCalledTimes(2);
    } finally {
      placing.mockRestore();
      kept.mockRestore();
    }

    expect(logged(logger.error).filter(said => said === 'Stocking failed')).toHaveLength(1);
    expect(logged(logger.warn)).toContain('Could not clear staging');
  });

  /** Staging that cannot be cleared once a partition is in the vault: it is stocked, and counted so. */
  it('counts a partition in the vault as built where its staging cannot be cleared after it', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));

    const stage  = join(config.vaultDir, SCRATCH, 'stage');
    const real   = vi.mocked(rm).getMockImplementation()!;
    const failed = vi.fn();

    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (dirname(String(path)) === stage) {
        failed(path);

        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      }

      return real(path, options);
    });

    try {
      expect(await sweep(conns)).toMatchObject({ built: 1, failed: 0 });
      expect(failed).toHaveBeenCalled();
    } finally {
      vi.mocked(rm).mockImplementation(real);
    }

    expect(await stocked()).toEqual(['@/202606.parquet']);
    expect((await linesOf(LEDGER)).map(line => line['partition'])).toEqual([`${SLICE}/${MONTH}`]);
    expect(logged(logger.error)).toEqual([]);
    expect(logged(logger.warn)).toContain('Could not clear staging');
  });

  /** On disk as catalogued, so not missing: the warning that there is no room is the one thing said of it. */
  it('counts a partition there is no room to extract as waiting for room, not as missing', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));

    const short = vi.spyOn(room, 'shortOf').mockResolvedValue({ needs: 10 * 1024 ** 3, free: 1024 ** 3 });

    try {
      expect(await sweep(conns)).toMatchObject({ built: 0, missing: 0, noRoom: 1, failed: 0 });
    } finally {
      short.mockRestore();
    }

    expect(logged(logger.warn).filter(said => said === 'Not enough space to extract — partition skipped')).toHaveLength(1);
    expect([...logged(logger.info), ...logged(logger.warn)].filter(said => said.includes('not on disk'))).toEqual([]);
  });

  /** Room when it was decided, and none by the time its build asks: it waits for room, and nothing of it is touched. */
  it('counts a partition that finds no room as it is built as waiting for room, not as failed', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));

    const short = vi.spyOn(room, 'shortOf')
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ needs: 10 * 1024 ** 3, free: 1024 ** 3 });

    try {
      expect(await sweep(conns)).toMatchObject({ built: 0, noRoom: 1, failed: 0 });
    } finally {
      short.mockRestore();
    }

    expect(await stocked()).toEqual([]);
    expect(await readFile(join(config.vaultDir, LEDGER), 'utf8').catch(() => '')).not.toContain(`${SLICE}/${MONTH}`);
    expect(logged(logger.warn)).toContain('Not enough space to extract — partition skipped');
    expect(logged(logger.error)).toEqual([]);

    expect(await sweep(conns)).toMatchObject({ built: 1, noRoom: 0 });
  });

  /** Nothing in the vault is touched until everything is built: a build that fails leaves the month as it was. */
  it('leaves a stocked month as it was where stocking it again fails', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    await sweep(conns);

    const [file]  = await stocked();
    const path    = join(config.vaultDir, SLICE, file!);
    const before  = await readFile(path);
    const [was]   = await linesOf(LEDGER);
    const archive = join(config.archivesDir, key('BTC_USDT'));
    const good    = await readFile(archive);

    // Changed in the catalog, and no gzip at all on disk.
    await writeFile(archive, Buffer.alloc(good.length));
    listed[0]!.ETag = '"e2"';

    expect(await sweep(conns)).toMatchObject({ built: 0, failed: 1 });
    expect(logged(logger.error)).toContain('Stocking failed');

    expect(await stocked()).toEqual([file]);
    expect((await readFile(path)).equals(before)).toBe(true);

    // Said to be outdated before anything was done about it, and nothing since: it was never said to be changing.
    const lines = await linesOf(LEDGER);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual(was);
    expect(lines[1]!['revision']).toBe('outdated');
    expect(await validate()).toBe(0);

    await writeFile(archive, good);

    expect(await sweep(conns)).toMatchObject({ built: 1, failed: 0 });
  });

  /** Stopped with some of a month's files moved in and the rest not: the month is put right at once, and stocked again. */
  it('puts right a month that fails half way into place', async () => {
    splitAt(1);

    try {
      await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
      await place('gate.futures_btc-trades.csv', key('BTC_USD'));
      await sweep(conns);

      listed[0]!.ETag = '"e2"';

      // The first instrument's file moves in, and the disk fails before the second.
      const placing = vi.spyOn(vault, 'publishSplit').mockImplementationOnce(async () => {
        await mkdir(join(config.vaultDir, SLICE, 'BTC_USD'), { recursive: true });
        await writeFile(join(config.vaultDir, SLICE, 'BTC_USD', '202606.parquet'), 'half');

        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      });

      try {
        expect(await sweep(conns)).toMatchObject({ built: 0, failed: 1 });
      } finally {
        placing.mockRestore();
      }

      // Nothing of it is left half in place, and the ledger still says it was changing — so it is not taken for stocked.
      expect(await stocked()).toEqual([]);
      expect((await linesOf(LEDGER)).at(-1)!['revision']).toBe('updating');
      expect(logged(logger.warn)).toContain(
        'A partition was stopped while its files were replaced — what was left of it is removed, and it will be stocked again');

      expect(await sweep(conns)).toMatchObject({ built: 1, failed: 0, files: 2 });
      expect(await stocked()).toEqual(['BTC_USD/202606.parquet', 'BTC_USDT/202606.parquet']);
    } finally {
      splitAt(null);
    }
  });

  /** A big instrument built a piece at a time: what was built before a failure is not built again. */
  it('keeps the pieces built before a failure, and takes them up the next time', async () => {
    directAt(1);
    pieceAt(1);

    const real = build.buildGroup;

    try {
      await zipped('binance.spot-trades.csv', binance('BTCUSDT', '20200101'));
      await zipped('binance.spot-trades.csv', binance('BTCUSDT', '20200102'));

      // The first piece is built, and the second fails.
      let calls = 0;
      const failing = vi.spyOn(build, 'buildGroup').mockImplementation(async (...args) => {
        if (++calls === 2) throw Object.assign(new Error('EIO'), { code: 'EIO' });

        return real(...args);
      });

      try {
        expect(await sweep(conns)).toMatchObject({ built: 0, failed: 1 });
      } finally {
        failing.mockRestore();
      }

      const stage = join(config.vaultDir, SCRATCH, 'stage');
      const notes = ((await readdir(stage, { recursive: true })) as string[]).filter(name => name.endsWith(`${build.PIECES}/0/0/.built`));

      expect(notes).toHaveLength(1);
      expect(((await readdir(stage, { recursive: true })) as string[]).filter(name => name.includes(`${build.PIECES}/0/1`))).toEqual([]);

      const piece   = join(stage, dirname(notes[0]!), 'BTCUSDT.parquet');
      const stamped = await stat(piece);

      // Taken up: only the piece that failed is built, and the one kept is read as it is.
      const join_    = build.joinPieces;
      const building = vi.spyOn(build, 'buildGroup');
      const joining  = vi.spyOn(build, 'joinPieces').mockImplementation(async (...args) => {
        const now = await stat(piece);

        expect([now.ino, now.mtimeMs]).toEqual([stamped.ino, stamped.mtimeMs]);

        return join_(...args);
      });

      try {
        expect(await sweep(conns)).toMatchObject({ built: 1, failed: 0 });
        expect(building).toHaveBeenCalledTimes(1);
        expect(building.mock.calls[0]![3].map(one => one.file.key)).toEqual([parseKey(binance('BTCUSDT', '20200102'))!.key]);
        expect(joining).toHaveBeenCalled();
      } finally {
        building.mockRestore();
        joining.mockRestore();
      }

      const rows = await conns[0]!.runAndReadAll(
        `SELECT count(*)::INT FROM read_parquet('${join(config.vaultDir, 'venue=binance', '**', '*.parquet')}')`);

      expect(rows.getRows()[0]![0]).toBe(2 * (await readFile(join(FIXTURES, 'binance.spot-trades.csv'), 'utf8')).trim().split('\n').length);
    } finally {
      directAt(null);
      pieceAt(null);
    }
  });

  /** The volume falling below its floor stops the sweep where it is: what was decided is stocked, and nothing after it. */
  it('stops part way where the volume falls below its floor', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT', '202604'));
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT', '202605'));
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT', '202606'));

    const floor = config.minFreeGb;
    const real  = disk.filesOf;

    // The volume fills once the first month is in the vault, as the second is looked at.
    const looking = vi.spyOn(disk, 'filesOf').mockImplementation(async (at, instruments) => {
      if (at.month === '2026-05') {
        await vi.waitFor(async () => expect(await readFile(join(config.vaultDir, LEDGER), 'utf8')).toContain(`${SLICE}/202604`),
          { timeout: 5_000 });

        config.minFreeGb = 1e9;
      }

      return real(at, instruments);
    });

    try {
      expect(await sweep(conns)).toMatchObject({ stopped: true, built: 1, failed: 0 });
    } finally {
      looking.mockRestore();
      config.minFreeGb = floor;
    }

    expect(await stocked()).toEqual(['@/202604.parquet']);
    expect((await linesOf(LEDGER)).map(line => line['partition'])).toEqual([`${SLICE}/202604`]);
    expect(logged(logger.warn)).toContain('Vault volume is low on space — stopping this sweep');
  });
});

/**
 * A heavy partition has every connection to itself, and its tasks are built
 * side by side on them; light ones share the connections, a partition each.
 */
describe('partitions sharing the engine', () => {
  afterEach(() => { aloneAt(null); directAt(null); });

  it('builds a heavy partition alone', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT', '202605'));
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT', '202606'));
    await place('gate.futures_btc-trades.csv', key('BTC_USD', '202606'));

    // June's two files make it heavy, and each of its instruments is a task of its own; May's one file is light.
    aloneAt(listed[1]!.Size + listed[2]!.Size);
    directAt(1);

    expect(listed[0]!.Size).toBeLessThan(listed[1]!.Size + listed[2]!.Size);

    const spans: { month: string; from: number; to: number }[] = [];
    const real = build.buildGroup;
    const building = vi.spyOn(build, 'buildGroup').mockImplementation(async (...args) => {
      const from = performance.now();

      // Long enough that two builds running at once are seen to.
      await new Promise(resolve => setTimeout(resolve, 100));

      try {
        return await real(...args);
      } finally {
        spans.push({ month: args[1].month, from, to: performance.now() });
      }
    });

    try {
      expect(await sweep(conns)).toMatchObject({ built: 2, failed: 0 });
    } finally {
      building.mockRestore();
    }

    const heavy = spans.filter(span => span.month === '2026-06');
    const light = spans.filter(span => span.month === '2026-05');
    const meet  = (a: { from: number; to: number }, b: { from: number; to: number }): boolean => a.from < b.to && b.from < a.to;

    expect(heavy).toHaveLength(2);
    expect(light).toHaveLength(1);

    // Never beside the other partition, and its own two side by side.
    for (const one of heavy) expect(meet(one, light[0]!)).toBe(false);

    expect(meet(heavy[0]!, heavy[1]!)).toBe(true);
  });
});

/**
 * A shutdown in the middle of a sweep: the partition being stocked is put in
 * place whole, no other is, and the engine is closed once nothing runs on it.
 */
describe('a sweep drained for a shutdown', () => {
  afterEach(() => { aloneAt(null); directAt(null); });

  it('finishes the placement under way, starts no other, and closes the engine, within the bound', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT', '202604'));
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT', '202605'));
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT', '202606'));

    // Every partition heavy, so they are stocked one at a time; each instrument built on its own.
    aloneAt(1);
    directAt(1);

    const engine = await open();
    const closed = vi.fn(engine.close);
    const pool   = vi.fn(async () => {});
    const scans  = new Scans(60 * 60 * 1000);
    const bound  = 20_000;
    const months: string[] = [];

    let draining: Promise<void> | undefined;
    let summary:  Summary | undefined;

    const real = build.buildGroup;

    // The signal comes as the first partition is being built, and the build takes a while after it.
    const building = vi.spyOn(build, 'buildGroup').mockImplementation(async (...args) => {
      months.push(args[1].month);
      draining ??= drain(scans, bound, { engine: closed, pool });

      await new Promise(resolve => setTimeout(resolve, 100));

      return real(...args);
    });

    const from = performance.now();

    try {
      await scans.start(async stop => { summary = await sweep(engine.conns, stop); });
      await draining;
    } finally {
      building.mockRestore();
    }

    expect(performance.now() - from).toBeLessThan(bound);
    expect(summary).toMatchObject({ built: 1, failed: 0, drained: true });
    expect([...new Set(months)]).toEqual(['2026-04']);
    expect(await stocked()).toEqual(['@/202604.parquet']);
    expect((await linesOf(LEDGER)).map(line => [line['partition'], line['revision']]))
      .toEqual([[`${SLICE}/202604`, expect.stringMatching(/^[0-9a-f]{12}$/)]]);

    expect(closed).toHaveBeenCalledOnce();
    expect(pool).toHaveBeenCalledOnce();

    for (const conn of engine.conns) await expect(conn.run('SELECT 1')).rejects.toThrow(/disconnected/);
  });

  /** Decided ahead and never to be stocked: nothing more is extracted for them while the placement under way ends. */
  it('gives up what was decided ahead as soon as it is told to stop', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT', '202604'));
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT', '202605'));
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT', '202606'));

    // Every partition heavy, so the first is stocked alone and the others wait, decided; each instrument built on its own.
    aloneAt(1);
    directAt(1);

    const baseline = held();
    const stop     = new AbortController();
    const released = vi.spyOn(Prefetch.prototype, 'release');
    const real     = build.buildGroup;
    const files    = disk.filesOf;
    const looked   = new Set<string>();

    let whileBuilding = -1;

    const looking = vi.spyOn(disk, 'filesOf').mockImplementation(async (at, instruments) => {
      const found = await files(at, instruments);

      looked.add(at.month);

      return found;
    });

    const building = vi.spyOn(build, 'buildGroup').mockImplementation(async (...args) => {
      if (whileBuilding < 0) {
        // Both later months decided before the signal comes.
        await vi.waitFor(() => expect(looked).toEqual(new Set(['2026-04', '2026-05', '2026-06'])));
        await new Promise(resolve => setTimeout(resolve, 20));

        stop.abort();
        await new Promise(resolve => setTimeout(resolve, 20));

        whileBuilding = released.mock.calls.length;
      }

      return real(...args);
    });

    try {
      expect(await sweep(conns, stop.signal)).toMatchObject({ built: 1, failed: 0, drained: true });
    } finally {
      building.mockRestore();
      looking.mockRestore();
      released.mockRestore();
    }

    expect(whileBuilding).toBe(2);
    expect(await stocked()).toEqual(['@/202604.parquet']);
    await vi.waitFor(() => expect(held()).toBe(baseline));
  });

  it('stocks nothing once told to stop before it starts', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));

    const stop = new AbortController();

    stop.abort();

    expect(await sweep(conns, stop.signal)).toMatchObject({ built: 0, considered: 0, drained: true });
    expect(await stocked()).toEqual([]);
    expect(queries).toEqual([]);
  });
});
