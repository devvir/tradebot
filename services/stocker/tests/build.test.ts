import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBatch, buildGroup } from '../src/build';
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
      `SELECT DISTINCT margin FROM read_parquet('${join(batch, '**', '*BTC_USD.*.parquet')}')`);

    expect(margins.getRows()).toEqual([['inverse']]);
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
