import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PIECES, buildBatch, buildGroup, bundleStaged, joinPieces } from '../src/build';
import { parseKey } from '../src/keys';
import { _test_pieceAt as pieceAt, _test_piecedOf as piecedOf, _test_tasksOf as tasksOf } from '../src/scan';
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

  /**
   * Where the month is one file, a batch is written as one: the same rows in
   * the same order as its instruments' files joined, margining and all.
   */
  it('as one file, what the instruments\' files join into', async () => {
    const usdt = await input('gate.futures_usdt-trades.csv', 'gate/perp/trades/B/BTC_USDT/202606/gate|perp|trades|BTC_USDT|202606.csv.gz');
    const btc  = await input('gate.futures_btc-trades.csv', 'gate/perp/trades/B/BTC_USD/202606/gate|perp|trades|BTC_USD|202606.csv.gz');

    const groups = [{ symbol: 'BTC_USDT', inputs: [usdt] }, { symbol: 'BTC_USD', inputs: [btc] }];
    const apart  = join(dir, 'whole-apart');
    const whole  = join(dir, 'whole');

    const parts = await buildBatch(conn, gate, groups, apart);
    const done  = await buildBatch(conn, gate, groups, whole, undefined, true);

    expect(done).toEqual(parts);
    expect(await written(whole)).toHaveLength(1);

    const ordered = async (path: string): Promise<string> =>
      JSON.stringify((await conn.runAndReadAll(`SELECT * FROM read_parquet('${path}')`)).getRows(),
        (_k, v) => (typeof v === 'bigint' ? String(v) : v));

    const columns = async (path: string): Promise<string[]> =>
      (await conn.runAndReadAll(`SELECT * FROM read_parquet('${path}') LIMIT 0`)).columnNames();

    const joined = await bundleStaged(conn, gate, apart);
    const single = await bundleStaged(conn, gate, whole);

    expect(await columns(single)).toEqual(await columns(joined));
    expect(await ordered(single)).toBe(await ordered(joined));
  });

  /**
   * A big instrument is read on its own, whatever the batches around it hold:
   * its symbol can fall in the middle of one, and the month is still in order.
   */
  it('joins a batch written whole with an instrument from the middle of it', async () => {
    const usdt = await input('gate.futures_usdt-trades.csv', 'gate/perp/trades/B/BTC_USDT/202606/gate|perp|trades|BTC_USDT|202606.csv.gz');
    const btc  = await input('gate.futures_btc-trades.csv', 'gate/perp/trades/B/BTC_USD/202606/gate|perp|trades|BTC_USD|202606.csv.gz');
    const here = join(dir, 'whole-mixed');

    // The batch holds AAA and ZZZ; BTC_USD, alone, sorts between them.
    const batch = await buildBatch(conn, gate, [{ symbol: 'AAA_USDT', inputs: [usdt] }, { symbol: 'ZZZ_USDT', inputs: [usdt] }], here, undefined, true);
    const alone = await buildGroup(conn, gate, 'BTC_USD', [btc], here);

    const joined = await bundleStaged(conn, gate, here);
    const read   = await conn.runAndReadAll(`SELECT symbol, ts FROM read_parquet('${joined}')`);
    const rows   = read.getRows().map(row => [String(row[0]), BigInt(row[1] as bigint)] as const);

    expect(rows).toHaveLength(batch.rows + alone.rows);
    expect(rows).toEqual([...rows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
    expect([...new Set(rows.map(row => row[0]))]).toEqual(['AAA_USDT', 'BTC_USD', 'ZZZ_USDT']);
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
    const book: VaultKey = { table: 'orderBook', venue: 'gate', market: 'perp', kind: 'incremental', depth: 'full', month: '2026-06' };
    const file = await input('gate.futures-books-shuffled.csv',
      'gate/perp/books,incremental,full/B/BTC_USD/202606/gate|perp|books,incremental,full|BTC_USD|20260601.part21.csv.gz');
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

/**
 * An instrument whose archives inflate to more than scratch should hold at
 * once is built a few of them at a time, and comes out as it would whole.
 */
describe('a big instrument built a piece at a time', () => {
  /** A zip holding `bytes` of rows, said to weigh enough on disk to be read alone. */
  const heavy = (name: string, bytes: number): DiskFile => {
    const from = join(dir, `${name}.d`);
    const path = join(dir, `${name}.zip`);

    execFileSync('mkdir', ['-p', from]);
    writeFileSync(join(from, 'rows.csv'), 'x'.repeat(bytes));
    execFileSync('zip', ['-q', path, 'rows.csv'], { cwd: from });

    return { absolute: path, size: 40 * 1024 ** 2, mtimeMs: 0, file: { container: 'zip' } } as unknown as DiskFile;
  };

  it('is cut where its files would inflate past a piece, by what they inflate to', async () => {
    const files = [heavy('p1', 600), heavy('p2', 300), heavy('p3', 300), heavy('p4', 2_000), heavy('p5', 100)];

    pieceAt(1_000);

    try {
      const pieced = await piecedOf([[{ symbol: 'A', inputs: [files[0]!] }], [{ symbol: 'BIG', inputs: files }]]);

      expect(pieced.map(task => task[0]!.inputs.map(one => files.indexOf(one)))).toEqual([[0], [0, 1], [2], [3], [4]]);
      expect(pieced.map(task => task[0]!.piece?.at)).toEqual([undefined, 0, 1, 2, 3]);
      expect(new Set(pieced.slice(1).map(task => task[0]!.piece!.of)).size).toBe(1);

      // Small enough to be held at once: left as it was.
      pieceAt(10_000);

      expect(await piecedOf([[{ symbol: 'BIG', inputs: files }]])).toEqual([[{ symbol: 'BIG', inputs: files }]]);
    } finally {
      pieceAt(null);
    }
  });

  it('joins into the file it would have been built as whole', async () => {
    const one = await input('gate.futures_usdt-trades.csv', 'gate/perp/trades/B/BTC_USDT/202606/gate|perp|trades|BTC_USDT|202606.csv.gz');
    const two = await input('gate.futures_btc-trades.csv', 'gate/perp/trades/B/BTC_USDT/202606/gate|perp|trades|BTC_USDT|202606.csv.gz');

    const whole  = join(dir, 'pieces-whole');
    const pieced = join(dir, 'pieces');

    await buildGroup(conn, gate, 'BTC_USDT', [one, two], whole);

    // Built later piece first: the join is what puts the rows in order.
    await buildGroup(conn, gate, 'BTC_USDT', [two], join(pieced, PIECES, '0', '1'));
    await buildGroup(conn, gate, 'BTC_USDT', [one], join(pieced, PIECES, '0', '0'));

    await joinPieces(conn, gate, pieced, () => false);

    expect(await written(pieced)).toEqual(['BTC_USDT.parquet']);
    expect(await rowsOf(join(pieced, 'BTC_USDT.parquet'))).toBe(await rowsOf(join(whole, 'BTC_USDT.parquet')));

    const times = (await conn.runAndReadAll(`SELECT ts FROM read_parquet('${join(pieced, 'BTC_USDT.parquet')}')`)).getRows().map(row => BigInt(row[0] as bigint));

    expect(times).toEqual([...times].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });
});
