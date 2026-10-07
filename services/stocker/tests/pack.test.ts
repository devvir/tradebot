import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBatch, bundleStaged, wrappedFor } from '../src/build';
import { unpackAll } from '../src/containers';
import { extractInto } from '../src/containers/extract';
import { Packer } from '../src/containers/pack';
import { parseKey } from '../src/keys';
import type { DiskFile, VaultKey } from '../src/types';

/**
 * Small files of one shape are gathered into one, each line saying which
 * archive it came from, so the engine opens one file and not thousands. What
 * it reads of them must be what it read of the files apart — and a file that
 * cannot be cut at its line ends is left as a file.
 */

const FIXTURES = join(__dirname, 'fixtures');

let dir: string;
let instance: DuckDBInstance;
let conn: Awaited<ReturnType<DuckDBInstance['connect']>>;

beforeAll(async () => {
  dir      = await mkdtemp(join(tmpdir(), 'stocker-pack-'));
  instance = await DuckDBInstance.create(':memory:');
  conn     = await instance.connect();
});

afterAll(async () => {
  conn?.closeSync?.();
  await rm(dir, { recursive: true, force: true });
});

/** A packer on a file of its own, and what it wrote once closed. */
const packing = (name: string, header = false): { packer: Packer; written: () => string | null } => {
  const path   = join(dir, name);
  const packer = new Packer(path, { header });

  return { packer, written: () => (packer.close() ? readFileSync(path, 'utf8') : null) };
};

const text = (body: string): Buffer => Buffer.from(body);

describe('gathering small files into one', () => {
  it('writes every line under the number of its archive', () => {
    const { packer, written } = packing('lines.csv');

    expect(packer.add(0, text('1,a\n2,b\n'))).toBe(true);
    expect(packer.add(7, text('3,c\n'))).toBe(true);

    expect(written()).toBe('0,1,a\n0,2,b\n7,3,c\n');
  });

  it('ends a last line that had no end, and leaves empty lines out', () => {
    const { packer, written } = packing('ends.csv');

    packer.add(1, text('1,a\n\n2,b'));

    expect(written()).toBe('1,1,a\n1,2,b\n');
  });

  it('takes a carriage return before a line feed as part of the line end', () => {
    const { packer, written } = packing('crlf.csv');

    packer.add(2, text('1,a\r\n2,b\r\n'));

    expect(written()).toBe('2,1,a\n2,2,b\n');
  });

  it('leaves out the mark a file may open with', () => {
    const { packer, written } = packing('bom.csv');

    packer.add(3, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), text('1,a\n')]));

    expect(written()).toBe('3,1,a\n');
  });

  /** A quoted cell may hold a line end, so a line is no longer a row. */
  it('refuses a file holding a quote', () => {
    const { packer, written } = packing('quoted.csv');

    expect(packer.add(0, text('1,"a\nb"\n'))).toBe(false);
    expect(written()).toBeNull();
  });

  it('refuses a sheet, a file with bare carriage returns, and a large file', () => {
    const { packer, written } = packing('refused.csv');

    expect(packer.add(0, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), text('rest')]))).toBe(false);
    expect(packer.add(1, text('1,a\r2,b\r'))).toBe(false);
    expect(packer.add(2, text('1,a\n'.repeat(20_000)))).toBe(false);

    expect(written()).toBeNull();
  });

  /** Nothing to read is not something to leave as a file. */
  it('takes an empty file as gathered, with nothing of it written', () => {
    const { packer, written } = packing('empty.csv');

    expect(packer.add(0, Buffer.alloc(0))).toBe(true);
    expect(written()).toBeNull();
  });

  it('keeps a header once, in front of every file that opens with it', () => {
    const { packer, written } = packing('headed.csv', true);

    expect(packer.add(0, text('ts,price\n1,a\n'))).toBe(true);
    expect(packer.add(1, text('ts,price\r\n2,b\r\n'))).toBe(true);

    expect(written()).toBe('_tag,ts,price\n0,1,a\n1,2,b\n');
  });

  /** Columns in another order under one header would be read as the first file's. */
  it('refuses a file whose header is not the first one\'s', () => {
    const { packer, written } = packing('headers.csv', true);

    expect(packer.add(0, text('ts,price\n1,a\n'))).toBe(true);
    expect(packer.add(1, text('price,ts\nb,2\n'))).toBe(false);

    expect(written()).toBe('_tag,ts,price\n0,1,a\n');
  });

  it('refuses a header whose columns are not separated by commas', () => {
    const { packer, written } = packing('tabs.csv', true);

    expect(packer.add(0, text('ts\tprice\n1\ta\n'))).toBe(false);
    expect(packer.add(1, text('ts;price,more\n1;a,b\n'))).toBe(false);

    expect(written()).toBeNull();
  });
});

describe('extracting archives whose small files are gathered', () => {
  /** A zip of these members, written with the system's own `zip`. */
  const zipOf = (name: string, members: Record<string, string>): string => {
    const from = join(dir, `${name}.d`);
    const path = join(dir, name);

    execFileSync('mkdir', ['-p', from]);

    for (const [member, body] of Object.entries(members)) writeFileSync(join(from, member), body);

    execFileSync('zip', ['-q', path, ...Object.keys(members)], { cwd: from });

    return path;
  };

  const into = async (name: string): Promise<string> => {
    const out = join(dir, name);

    await mkdir(out, { recursive: true });

    return out;
  };

  it('gathers zip members, and writes out the one that cannot be', async () => {
    const done = await extractInto([
      { absolute: zipOf('one.zip', { 'a.csv': '1,a\n' }), container: 'zip', shape: 0 },
      { absolute: zipOf('two.zip', { 'b.csv': '2,"b"\n' }), container: 'zip', shape: 0 },
      { absolute: zipOf('three.zip', { 'c.csv': '3,c\n' }), container: 'zip', shape: 0 },
    ], await into('zips'), [{ header: false }]);

    expect(done.paths[0]).toEqual([]);
    expect(done.paths[2]).toEqual([]);
    expect(done.paths[1]!.map(path => readFileSync(path, 'utf8'))).toEqual(['2,"b"\n']);

    expect(readFileSync(done.packs[0]!, 'utf8').split('\n').filter(Boolean).sort()).toEqual(['0,1,a', '2,3,c']);
  });

  it('gathers small files the engine would read where they lie, and leaves the rest there', async () => {
    const small  = join(dir, 'small.csv.gz');
    const quoted = join(dir, 'quoted.csv.gz');
    const bare   = join(dir, 'bare.csv');
    const none   = join(dir, 'none.csv.gz');

    writeFileSync(small, gzipSync('1,a\n'));
    writeFileSync(quoted, gzipSync('2,"b"\n'));
    writeFileSync(bare, '3,c\n');
    writeFileSync(none, '');

    const done = await extractInto([
      { absolute: small, container: 'gzip', shape: 0 },
      { absolute: quoted, container: 'gzip', shape: 0 },
      { absolute: bare, container: 'plain', shape: 0 },
      { absolute: none, container: 'gzip', shape: 0 },
    ], await into('natives'), [{ header: false }]);

    expect(done.paths).toEqual([[], [quoted], [], []]);
    expect(readFileSync(done.packs[0]!, 'utf8').split('\n').filter(Boolean).sort()).toEqual(['0,1,a', '2,3,c']);
  });

  it('gathers each shape into a file of its own', async () => {
    const done = await extractInto([
      { absolute: zipOf('s0.zip', { 'a.csv': '1,a\n' }), container: 'zip', shape: 0 },
      { absolute: zipOf('s1.zip', { 'b.csv': 'ts,p\n2,b\n' }), container: 'zip', shape: 1 },
      { absolute: zipOf('s2.zip', { 'c.csv': '3,c\n' }), container: 'zip' },
    ], await into('shapes'), [{ header: false }, { header: true }]);

    expect(readFileSync(done.packs[0]!, 'utf8')).toBe('0,1,a\n');
    expect(readFileSync(done.packs[1]!, 'utf8')).toBe('_tag,ts,p\n1,2,b\n');
    expect(done.paths[2]!.map(path => readFileSync(path, 'utf8'))).toEqual(['3,c\n']);
  });

  it('answers with no file for a shape nothing went into', async () => {
    const done = await extractInto(
      [{ absolute: zipOf('q.zip', { 'a.csv': '1,"a"\n' }), container: 'zip', shape: 0 }],
      await into('nothing'), [{ header: false }],
    );

    expect(done.packs).toEqual([null]);
    expect(done.paths[0]).toHaveLength(1);
  });

  it('extracts as ever where no shape is asked for', async () => {
    const all = await unpackAll([{ absolute: zipOf('plain.zip', { 'a.csv': '1,a\n' }), container: 'zip' }]);

    expect(all.packs).toEqual([]);
    expect(all.paths[0]!.map(path => readFileSync(path, 'utf8'))).toEqual(['1,a\n']);

    await all.dispose();
  });
});

describe('a batch read from gathered files', () => {
  /** A fixture as a file of the given key, read as plain CSV. */
  const input = async (fixture: string, key: string): Promise<DiskFile> => {
    const absolute = join(FIXTURES, fixture);

    return { absolute, file: { ...parseKey(key)!, container: 'plain' }, size: (await stat(absolute)).size, mtimeMs: 0 };
  };

  const rowsOf = async (path: string): Promise<string> =>
    JSON.stringify((await conn.runAndReadAll(`SELECT * FROM read_parquet('${path}')`)).getRows(),
      (_k, v) => (typeof v === 'bigint' ? String(v) : v));

  const columnsOf = async (path: string): Promise<string[]> =>
    (await conn.runAndReadAll(`SELECT * FROM read_parquet('${path}') LIMIT 0`)).columnNames();

  /** The same batch built from its files apart and from them gathered, each joined into the month's one file. */
  const bothWays = async (key: VaultKey, groups: { symbol: string; inputs: DiskFile[] }[], name: string) => {
    const apart    = join(dir, `${name}-apart`);
    const gathered = join(dir, `${name}-gathered`);

    const wrapped  = wrappedFor(groups);
    const prepared = await unpackAll(wrapped.inputs, wrapped.shapes);
    const packs    = prepared.packs.filter(pack => pack !== null).length;

    const plain = await buildBatch(conn, key, groups, apart, undefined, true);
    const done  = await buildBatch(conn, key, groups, gathered, prepared, true);

    return { plain, done, packs, apart: await bundleStaged(conn, key, apart), gathered: await bundleStaged(conn, key, gathered) };
  };

  /** Two margin kinds in one batch are two series: each is gathered into a file of its own. */
  it('is what the files apart give, for positional files of two series', async () => {
    const gate: VaultKey = { table: 'trades', venue: 'gate', market: 'perp', month: '2026-06' };

    const usdt = await input('gate.futures_usdt-trades.csv', 'gate/perp/trades/B/BTC_USDT/202606/gate|perp|trades|BTC_USDT|202606.csv.gz');
    const btc  = await input('gate.futures_btc-trades.csv', 'gate/perp/trades/B/BTC_USD/202606/gate|perp|trades|BTC_USD|202606.csv.gz');

    const both = await bothWays(gate, [{ symbol: 'BTC_USDT', inputs: [usdt] }, { symbol: 'BTC_USD', inputs: [btc] }], 'gate');

    expect(both.packs).toBeGreaterThan(0);
    expect(both.done).toEqual(both.plain);
    expect(await columnsOf(both.gathered)).toEqual(await columnsOf(both.apart));
    expect(await rowsOf(both.gathered)).toBe(await rowsOf(both.apart));
  });

  it('is what the files apart give, for files with a header', async () => {
    const key: VaultKey = { table: 'trades', venue: 'bybit', market: 'perp', month: '2026-07' };

    const one = await input('bybit.perp-trades.csv', 'bybit/perp/trades/B/BTCUSDT/202607/bybit|perp|trades|BTCUSDT|20260729.csv.gz');

    // A file of its own for the second instrument: a row is its instrument's by the file it is in.
    const copy = join(dir, 'bybit-second.csv');

    writeFileSync(copy, readFileSync(one.absolute));

    const two: DiskFile = {
      ...one, absolute: copy,
      file: { ...parseKey('bybit/perp/trades/E/ETHUSDT/202607/bybit|perp|trades|ETHUSDT|20260729.csv.gz')!, container: 'plain' },
    };

    const both = await bothWays(key, [{ symbol: 'BTCUSDT', inputs: [one] }, { symbol: 'ETHUSDT', inputs: [two] }], 'bybit');

    expect(both.packs).toBe(1);
    expect(both.done).toEqual(both.plain);
    expect(both.done.files).toBe(2);
    expect(await rowsOf(both.gathered)).toBe(await rowsOf(both.apart));
  });

  /**
   * A gathered read that fails may have failed only for being gathered, and
   * says nothing of which archive is why: the archives are read as they are.
   */
  it('is read again from the archives where the gathered read fails', async () => {
    const gate: VaultKey = { table: 'trades', venue: 'gate', market: 'perp', month: '2026-06' };

    const usdt   = await input('gate.futures_usdt-trades.csv', 'gate/perp/trades/B/BTC_USDT/202606/gate|perp|trades|BTC_USDT|202606.csv.gz');
    const groups = [{ symbol: 'BTC_USDT', inputs: [usdt] }];

    const wrapped  = wrappedFor(groups);
    const prepared = await unpackAll(wrapped.inputs, wrapped.shapes);

    // Many more columns than any series declares: the read refuses it.
    writeFileSync(prepared.packs[0]!, '0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20\n');

    const plain = await buildBatch(conn, gate, groups, join(dir, 'fallback-apart'), undefined, true);
    const done  = await buildBatch(conn, gate, groups, join(dir, 'fallback'), prepared, true);

    expect(done).toEqual(plain);
    expect(statSync(usdt.absolute).size).toBeGreaterThan(0);
  });
});
