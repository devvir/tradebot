import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBatch, buildGroup, bundleStaged } from '../src/build';
import { parseKey } from '../src/keys';
import { _test_tasksOf as tasksOf } from '../src/scan';
import type { DiskFile, VaultKey } from '../src/types';

/**
 * The two ways an instrument is built — on its own, or in a batch read with
 * others — must write the same file. Driven with real fixtures, through the
 * real build.
 */

const FIXTURES = join(__dirname, 'fixtures');

let dir: string;
let instance: DuckDBInstance;
let conn: Awaited<ReturnType<DuckDBInstance['connect']>>;

beforeAll(async () => {
  dir      = await mkdtemp(join(tmpdir(), 'stocker-build-'));
  instance = await DuckDBInstance.create(':memory:');
  conn     = await instance.connect();
});

afterAll(async () => {
  conn?.closeSync?.();
  await rm(dir, { recursive: true, force: true });
});

/** A fixture as a file of the given key, read as plain CSV. */
const input = async (fixture: string, key: string): Promise<DiskFile> => {
  const absolute = join(FIXTURES, fixture);

  return {
    absolute,
    file:    { ...parseKey(key)!, container: 'plain' },
    size:    (await stat(absolute)).size,
    mtimeMs: 0,
  };
};

/** Every parquet file under a directory, by its path relative to it. */
const written = async (root: string): Promise<string[]> =>
  ((await readdir(root, { recursive: true })) as string[]).filter(name => name.endsWith('.parquet')).sort();

const rowsOf = async (path: string): Promise<string> =>
  JSON.stringify((await conn.runAndReadAll(`SELECT * FROM read_parquet('${path}') ORDER BY ALL`)).getRows(),
    (_k, v) => (typeof v === 'bigint' ? String(v) : v));

const gate: VaultKey = { table: 'trades', venue: 'gate', market: 'perp', month: '2026-06' };

describe('a batch writes what instruments built alone would', () => {
  it('for a positional format, two instruments at once', async () => {
    const usdt = await input('gate.futures_usdt-trades.csv', 'gate/perp/trades/B/BTC_USDT/202606/gate|perp|trades|BTC_USDT|202606.csv.gz');
    const btc  = await input('gate.futures_btc-trades.csv', 'gate/perp/trades/B/BTC_USD/202606/gate|perp|trades|BTC_USD|202606.csv.gz');

    const alone = join(dir, 'alone');
    const batch = join(dir, 'batch');

    await buildGroup(conn, gate, 'BTC_USDT', [usdt], alone);
    await buildGroup(conn, gate, 'BTC_USD', [btc], alone);

    const done = await buildBatch(conn, gate, [
      { symbol: 'BTC_USDT', inputs: [usdt] },
      { symbol: 'BTC_USD',  inputs: [btc] },
    ], batch);

    expect(done.files).toBe(2);
    expect(await written(batch)).toEqual(await written(alone));

    for (const file of await written(alone))
      expect(await rowsOf(join(batch, file))).toBe(await rowsOf(join(alone, file)));

    // Margining per instrument: the BTC-settled contract is inverse.
    const margins = await conn.runAndReadAll(
      `SELECT DISTINCT symbol, margin FROM read_parquet('${join(batch, 'BTC_USD.parquet')}')`);

    expect(margins.getRows()).toEqual([['BTC_USD', 'inverse']]);
  });

  /**
   * A small month is stored as one file: its instruments appended in symbol
   * order, each already in time order, so nothing has to be sorted.
   */
  it('joins the instruments into one file, by symbol and then by time', async () => {
    const usdt = await input('gate.futures_usdt-trades.csv', 'gate/perp/trades/B/BTC_USDT/202606/gate|perp|trades|BTC_USDT|202606.csv.gz');
    const btc  = await input('gate.futures_btc-trades.csv', 'gate/perp/trades/B/BTC_USD/202606/gate|perp|trades|BTC_USD|202606.csv.gz');
    const here = join(dir, 'joined');

    // Built in the other order, so the join is what puts them right.
    const one = await buildGroup(conn, gate, 'BTC_USDT', [usdt], here);
    const two = await buildGroup(conn, gate, 'BTC_USD', [btc], here);

    const joined = await bundleStaged(conn, gate, here);
    const read   = await conn.runAndReadAll(`SELECT symbol, ts FROM read_parquet('${joined}')`);
    const rows   = read.getRows().map(row => [String(row[0]), BigInt(row[1] as bigint)] as const);

    expect(rows).toHaveLength(one.rows + two.rows);
    expect(rows).toEqual([...rows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
    expect(rows[0]![0]).toBe('BTC_USD');
  });

  /** A month with nothing in it is still a file, so it reads as stocked. */
  it('joins nothing into a file with the table\'s columns and no rows', async () => {
    const joined = await bundleStaged(conn, gate, join(dir, 'nothing'));
    const read   = await conn.runAndReadAll(`SELECT * FROM read_parquet('${joined}')`);

    expect(read.getRows()).toEqual([]);
    expect(read.columnNames().slice(0, 2)).toEqual(['symbol', 'ts']);
  });

  it('for a headed format', async () => {
    const key: VaultKey = { table: 'trades', venue: 'bybit', market: 'perp', month: '2026-07' };
    const one = await input('bybit.perp-trades.csv', 'bybit/perp/trades/B/BTCUSDT/202607/bybit|perp|trades|BTCUSDT|20260729.csv.gz');

    const alone = join(dir, 'bybit-alone');
    const batch = join(dir, 'bybit-batch');

    await buildGroup(conn, key, 'BTCUSDT', [one], alone);
    await buildBatch(conn, key, [{ symbol: 'BTCUSDT', inputs: [one] }], batch);

    const [file] = await written(alone);

    expect(await rowsOf(join(batch, file!))).toBe(await rowsOf(join(alone, file!)));
  });

  /** A market bundle is split by its rows' instrument column, whichever way it is read. */
  it('for a bundle split by instrument', async () => {
    const key: VaultKey = { table: 'funding', venue: 'okx', market: 'perp', kind: 'realised', month: '2026-07' };
    const all = await input('okx.all-fundingrates.csv', 'okx/perp/funding,realised/@/202607/okx|perp|funding,realised|@|20260729.zip');

    const alone = join(dir, 'okx-alone');
    const batch = join(dir, 'okx-batch');

    const a = await buildGroup(conn, key, '@', [all], alone);
    const b = await buildBatch(conn, key, [{ symbol: '@', inputs: [all] }], batch);

    expect(a.files).toBeGreaterThan(1);
    expect(b).toEqual(a);
    expect(await written(batch)).toEqual(await written(alone));
  });

  /** okx repeats whole rows in many files; exact repeats are written once, either way. */
  it('drops exact repeats where the series says the venue repeats rows', async () => {
    const key: VaultKey = { table: 'klines', venue: 'okx', market: 'spot', interval: '1m', month: '2026-07' };
    const doubled = join(dir, 'doubled.csv');

    execFileSync('bash', ['-c', `cat ${JSON.stringify(join(FIXTURES, 'okx.spot-candlesticks.csv'))} ` +
      `<(tail -n +2 ${JSON.stringify(join(FIXTURES, 'okx.spot-candlesticks.csv'))}) > ${JSON.stringify(doubled)}`]);

    const once  = await input('okx.spot-candlesticks.csv', 'okx/spot/klines,1m/B/BTC-USDT/202607/okx|spot|klines,1m|BTC-USDT|20260729.zip');
    const twice = { ...once, absolute: doubled };

    const a = await buildGroup(conn, key, 'BTC-USDT', [once], join(dir, 'okx-once'));
    const b = await buildGroup(conn, key, 'BTC-USDT', [twice], join(dir, 'okx-twice'));
    const c = await buildBatch(conn, key, [{ symbol: 'BTC-USDT', inputs: [twice] }], join(dir, 'okx-twice-batch'));

    expect(b.rows).toBe(a.rows);
    expect(c.rows).toBe(a.rows);
  });

  /** A wider file is refused in a batch as it is alone — read in the same pass. */
  it('refuses a file wider than the series', async () => {
    const wide = join(dir, 'wide.csv.gz');

    execFileSync('bash', ['-c', `printf '1627775982.133299,1389302462,1.985,2.063,2\\n' | gzip > ${JSON.stringify(wide)}`]);

    const file: DiskFile = {
      absolute: wide,
      file:     parseKey('gate/perp/trades/F/FIDA_USDT/202107/gate|perp|trades|FIDA_USDT|202107.csv.gz')!,
      size:     1,
      mtimeMs:  0,
    };

    await expect(buildBatch(conn, { ...gate, month: '2021-07' }, [{ symbol: 'FIDA_USDT', inputs: [file] }],
      join(dir, 'wide-batch'))).rejects.toThrow(/more columns than the series declares/);
  });
});

describe('a book\'s rows', () => {
  /**
   * Gate stamps a tenth of a second, and several changes share one. Their
   * order is the book, so a file is sorted by time and then by the venue's own
   * sequence — whatever order the rows were read in.
   */
  it('are written in the venue\'s sequence inside one time', async () => {
    const book: VaultKey = { table: 'orderBook', venue: 'gate', market: 'perp', depth: 'full', mode: 'incremental', month: '2026-06' };
    const file = await input('gate.futures-books-shuffled.csv',
      'gate/perp/books,full,incremental/B/BTC_USD/202606/gate|perp|books,full,incremental|BTC_USD|20260601.part21.csv.gz');
    const here = join(dir, 'book');

    await buildGroup(conn, book, 'BTC_USD', [file], here);

    const [name] = await written(here);
    const read   = await conn.runAndReadAll(`SELECT sequence, action, side FROM read_parquet('${join(here, name!)}')`);

    expect(read.getRows().map(row => [Number(row[0]), row[1], row[2]])).toEqual([
      [5_301_531_664, 'set', 'bid'], [5_301_531_665, 'take', 'ask'], [5_301_531_666, 'take', 'bid'],
      [5_301_531_667, 'make', 'ask'], [5_301_531_668, 'make', 'bid'],
    ]);
  });
});

describe('splitting a partition into work', () => {
  const group = (symbol: string, size: number) => ({
    symbol, inputs: [{ absolute: symbol, file: parseKey(`x/spot/trades/B/${symbol}/202001/x|spot|trades|${symbol}|202001.zip`)!, size, mtimeMs: 0 }],
  });

  it('reads a big instrument alone and batches the small ones', () => {
    const tasks = tasksOf([group('A', 1), group('BIG', 40 * 1024 ** 2), group('B', 1)]);

    expect(tasks.map(task => task.map(one => one.symbol))).toEqual([['BIG'], ['A', 'B']]);
  });

  it('closes a batch at its size', () => {
    const tasks = tasksOf([group('A', 30 * 1024 ** 2), group('B', 30 * 1024 ** 2), group('C', 30 * 1024 ** 2)]);

    expect(tasks.map(task => task.map(one => one.symbol))).toEqual([['A', 'B', 'C']]);
    expect(tasksOf(Array.from({ length: 300 }, (_, i) => group(`S${i}`, 1))).map(task => task.length))
      .toEqual([256, 44]);
  });
});
