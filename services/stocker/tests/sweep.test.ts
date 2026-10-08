import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@devvir/service-kit';
import config from '../src/config';
import { open } from '../src/db';
import { parseKey } from '../src/keys';
import { BACKEDUP, ERRORS, LEDGER, validate } from '../src/ledger';
import { _test_splitAt as splitAt, sweep } from '../src/scan';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { ListedSlice } from '../src/types';

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
  const line    = { ...Object.fromEntries(columns.map((name, at) => [name, last[at]!])), revision: 'updating', ...change };

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

  const month = (at: string): string => `bybit/perp/klines,1h/B/BTCUSDT/${at}/bybit|perp|klines,1h|BTCUSDT|${at}.csv.gz`;

  /** A file of rows written by hand: stamped in UTC+3, as the venue stamps them. */
  const publish = async (at: string, rows: string[], etag = 'e1'): Promise<void> => {
    const path = join(config.archivesDir, month(at));

    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.txt`, rows.join('\n') + '\n');
    execFileSync('bash', ['-c', `gzip -c ${JSON.stringify(`${path}.txt`)} > ${JSON.stringify(path)}`]);
    await rm(`${path}.txt`);

    listed.push({ Key: month(at), ETag: `"${etag}"`, Size: (await stat(path)).size });
  };

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

    expect(ledger.map(one => one['revision'] === 'updating')).toEqual([false, true, false]);
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

    await interrupt({ postVersion: '0123456789abcdef' });
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
