import { execFileSync } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import config from '../src/config';
import { open } from '../src/db';
import { sweep } from '../src/scan';
import type { DuckDBConnection } from '@duckdb/node-api';

/**
 * Whole sweeps, against a fake archives tree and a catalog answered by a stub:
 * what gets stocked, what reads as current, what restocks, what waits.
 */

const FIXTURES = join(__dirname, 'fixtures');
const MONTH    = '202606';

interface Listed { Key: string; ETag: string; Size: number }

let conns: DuckDBConnection[];
let close: () => void;
let listed: Listed[];
let pending: string[];

const key = (symbol: string, date = MONTH) =>
  `gate/perp/trades/B/${symbol}/${date.slice(0, 6)}/gate|perp|trades|${symbol}|${date}.csv.gz`;

/** Put a fixture in the archives under a key, gzipped, and list it. */
const place = async (fixture: string, at: string, etag = 'e1'): Promise<void> => {
  const path = join(config.archivesDir, at);

  await mkdir(dirname(path), { recursive: true });
  execFileSync('bash', ['-c', `gzip -c ${JSON.stringify(join(FIXTURES, fixture))} > ${JSON.stringify(path)}`]);

  listed.push({ Key: at, ETag: `"${etag}"`, Size: (await stat(path)).size });
};

/** The catalog's listing, from `listed` and `pending`, one page per prefix. */
const catalog = async (url: string | URL): Promise<Response> => {
  const query  = new URL(String(url)).searchParams;
  const prefix = query.get('prefix') ?? '';
  const owed   = query.get('pending') === 'true';

  const contents = listed
    .filter(one => one.Key.startsWith(prefix) && (! owed || pending.includes(one.Key)))
    .sort((a, b) => (a.Key < b.Key ? -1 : 1));

  return new Response(JSON.stringify({ Contents: contents, IsTruncated: false }), { status: 200 });
};

const versions = async (): Promise<string[]> =>
  readdir(join(config.vaultDir, 'venue=gate', 'market=perp', 'dataset=trades', MONTH)).catch(() => []);

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
  listed  = [];
  pending = [];

  await rm(config.archivesDir, { recursive: true, force: true });
  await rm(config.vaultDir, { recursive: true, force: true });
  await mkdir(config.vaultDir, { recursive: true });
});

describe('a sweep', () => {
  it('stocks a complete partition, one file per instrument, under its version', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    await place('gate.futures_btc-trades.csv', key('BTC_USD'));

    const summary = await sweep(conns);

    expect(summary).toMatchObject({ built: 1, failed: 0, files: 2 });

    const [version] = await versions();

    expect(version).toMatch(/^[0-9a-f]{12}$/);

    const files = (await readdir(join(config.vaultDir, 'venue=gate', 'market=perp', 'dataset=trades', MONTH, version!),
      { recursive: true }) as string[]).filter(name => name.endsWith('.parquet')).sort();

    expect(files).toEqual([
      'B/symbol=BTC_USD/trades.gate.perp.BTC_USD.202606.parquet',
      'B/symbol=BTC_USDT/trades.gate.perp.BTC_USDT.202606.parquet',
    ]);
  });

  it('finds it current the next time, and reads nothing', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));

    await sweep(conns);

    expect(await sweep(conns)).toMatchObject({ built: 0, current: 1 });
  });

  /** Whatever changes in the catalog changes the version, and the old one goes. */
  it('restocks when a file changes in the catalog, and keeps only the new version', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    await sweep(conns);

    const [before] = await versions();

    listed[0]!.ETag = '"e2"';

    expect(await sweep(conns)).toMatchObject({ built: 1 });

    const after = await versions();

    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before);
  });

  it('waits while any file is still owed', async () => {
    await place('gate.futures_usdt-trades.csv', key('BTC_USDT'));
    pending = [key('BTC_USDT')];

    expect(await sweep(conns)).toMatchObject({ built: 0, waiting: 1 });
    expect(await versions()).toEqual([]);
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

describe('a sweep below the space floor', () => {
  /** Nothing can be stocked, so the catalog is not even asked. */
  it('stops before listing anything', async () => {
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
