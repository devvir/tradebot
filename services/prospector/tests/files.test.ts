import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markDownloaded, putFiles, putVenue, recordSeries } from '../src/catalog';
import { openCatalog } from '../src/database';
import { setupRoutes } from '../src/api/routes';
import { levelsOf } from '../src/canonical';
import type { Application } from 'express';
import type { Found, Offered, Surveys } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The listing this service exists to serve.
 *
 * A consumer names what it wants in the catalog's own vocabulary and is answered
 * with URLs that work. What is pinned here is that every axis it may name is
 * actually accepted, that absent means *any*, and that `/pending` is the same
 * handler with one answer fixed — because a shortcut that drifts from what it
 * shortcuts is worse than two endpoints.
 */

let dir: string;
let db:  DatabaseSync;
let app: Application;
let id:  number;

const K1H_M = 'k/1h/{YYYY}{MM}/{SYMBOL}.zip';
const K1H_D = 'k/1h/{YYYY}{MM}{DD}/{SYMBOL}.zip';
const K15_M = 'k/15m/{YYYY}{MM}/{SYMBOL}.zip';
const TRADE = 't/{YYYY}{MM}/{SYMBOL}.zip';

const found = (over: Partial<Found>): Found => ({
  market: 'perp', dataset: 'klines', symbol: 'BTCUSDT', urlSymbol: 'BTCUSDT',
  pattern: K1H_M, ...over,
});

/** One series, and one catalogued file of it. */
const publish = async (over: Partial<Found>, path: string, date: string) => {
  const series = recordSeries(db, id, found(over), { first: date });

  await putFiles(db, [{
    venueId: id, path, date, size: 7, etag: 'e', modified: null,
    existence: 'confirmed', seriesId: series.id!, seenAt: 'T1',
  }]);
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'files-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });
  id  = putVenue(db, 'binance', 'https://data.binance.vision', '');

  await publish({ variant: '1h',  pattern: K1H_M }, 'k/1h/202406/BTCUSDT.zip',      '202406');
  await publish({ variant: '1h',  pattern: K1H_D }, 'k/1h/20240601/BTCUSDT.zip',    '20240601');
  await publish({ variant: '15m', pattern: K15_M }, 'k/15m/202406/BTCUSDT.zip',     '202406');
  await publish({ variant: '1h',  pattern: K1H_M, symbol: 'ETHUSDT', urlSymbol: 'ETHUSDT' },
    'k/1h/202406/ETHUSDT.zip', '202406');
  await publish({ dataset: 'trades', pattern: TRADE }, 't/202406/BTCUSDT.zip', '202406');

  const surveys: Surveys = {
    venues:  () => ['binance'],
    start:   () => undefined,
    running: () => false,
    paused:  () => false,
    pause:   () => false,
  };

  app = express();
  app.use(express.json());
  setupRoutes(app, db, surveys);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = async (path: string) => {
  const server = app.listen(0);
  const port   = (server.address() as { port: number }).port;

  try {
    const res  = await fetch(`http://127.0.0.1:${port}${path}`,
      { headers: { 'x-catalog-token': 'change-me' } });

    const body = await res.json() as { items: Offered[]; next: string | null };

    return { status: res.status, body, paths: body.items?.map(one => one.path) ?? [] };
  } finally {
    server.close();
  }
};

describe('naming what you want', () => {
  it('answers the whole venue when nothing narrows it', async () => {
    const { paths } = await get('/venues/binance/files');

    expect(paths).toHaveLength(5);
  });

  it('narrows to a dataset', async () => {
    expect((await get('/venues/binance/files?dataset=trades')).paths)
      .toEqual(['t/202406/BTCUSDT.zip']);
  });

  /**
   * Without this a caller asking for klines is handed every bar length the venue
   * publishes, mixed together, and has to sort them out by reading paths.
   */
  it('narrows to a variant', async () => {
    expect((await get('/venues/binance/files?dataset=klines&variant=15m')).paths)
      .toEqual(['k/15m/202406/BTCUSDT.zip']);
  });

  /**
   * The same month filed twice is the case this exists for: without it a caller
   * asking for June trades gets the monthly file and every day of that month.
   */
  it('narrows to a rendering', async () => {
    expect((await get('/venues/binance/files?variant=1h&grain=daily')).paths)
      .toEqual(['k/1h/20240601/BTCUSDT.zip']);

    expect((await get('/venues/binance/files?variant=1h&grain=monthly')).paths.sort())
      .toEqual(['k/1h/202406/BTCUSDT.zip', 'k/1h/202406/ETHUSDT.zip']);
  });

  it('refuses a grain it does not publish, rather than answering nothing', async () => {
    const { status, body } = await get('/venues/binance/files?grain=fortnightly');

    expect(status).toBe(400);
    expect(body).toHaveProperty('error');
  });

  it('narrows to several instruments, however they are named', async () => {
    expect((await get('/venues/binance/files?symbol=ETHUSDT')).paths)
      .toEqual(['k/1h/202406/ETHUSDT.zip']);

    expect((await get('/venues/binance/files?symbol=BTCUSDT,ETHUSDT')).paths).toHaveLength(5);
    expect((await get('/venues/binance/files?symbol=BTCUSDT&symbol=ETHUSDT')).paths)
      .toHaveLength(5);
  });

  it('matches instruments case-blind', async () => {
    expect((await get('/venues/binance/files?symbol=ethusdt')).paths)
      .toEqual(['k/1h/202406/ETHUSDT.zip']);
  });

  /** An explicit set that matches nothing is not "no filter". */
  it('answers nothing when the instruments named publish nothing', async () => {
    expect((await get('/venues/binance/files?symbol=NOPEUSDT')).paths).toEqual([]);
  });

  it('composes every axis at once', async () => {
    expect((await get(
      '/venues/binance/files?dataset=klines&variant=1h&grain=monthly&symbol=BTCUSDT',
    )).paths).toEqual(['k/1h/202406/BTCUSDT.zip']);
  });

  /**
   * `month` catches both grains of one calendar month, which neither `to` nor
   * `from` can: an inclusive `202406` sorts below every daily file of June.
   */
  it('takes a whole month whatever grain its files are in', async () => {
    expect((await get('/venues/binance/files?month=202406')).paths).toHaveLength(5);
    expect((await get('/venues/binance/files?to=202406')).paths).toHaveLength(4);
  });
});

describe('what is held and what is owed', () => {
  beforeEach(() => {
    markDownloaded(db, [{ venueId: id, path: 'k/1h/202406/BTCUSDT.zip' }], 'T2');
  });

  it('answers either when nothing asks', async () => {
    expect((await get('/venues/binance/files')).paths).toHaveLength(5);
  });

  it('answers what is held', async () => {
    expect((await get('/venues/binance/files?downloaded=true')).paths)
      .toEqual(['k/1h/202406/BTCUSDT.zip']);
  });

  it('answers what is owed', async () => {
    expect((await get('/venues/binance/files?downloaded=false')).paths).toHaveLength(4);
  });

  it('says which each row is, since an unscoped listing must', async () => {
    const held = (await get('/venues/binance/files')).body.items;

    expect(held.find(one => one.path === 'k/1h/202406/BTCUSDT.zip')?.downloadedAt).toBe('T2');
    expect(held.find(one => one.path === 't/202406/BTCUSDT.zip')?.downloadedAt).toBe(null);
  });

  /** The shortcut has to stay the same handler, or it drifts from what it shortcuts. */
  it('is what /pending is, with one answer fixed', async () => {
    const pending = await get('/venues/binance/pending?dataset=klines&variant=1h');
    const owed    = await get('/venues/binance/files?dataset=klines&variant=1h&downloaded=false');

    expect(pending.paths).toEqual(owed.paths);
    expect(pending.paths).not.toContain('k/1h/202406/BTCUSDT.zip');
  });
});

describe('what a row says about itself', () => {
  it('states the file rather than making a reader parse its path', async () => {
    const [row] = (await get('/venues/binance/files?dataset=trades')).body.items;

    expect(row).toMatchObject({
      market:  'perp',
      dataset: 'trades',
      symbol:  'BTCUSDT',
      date:    '202406',
      grain:   'monthly',
      ext:     '.zip',
      url:     'https://data.binance.vision/t/202406/BTCUSDT.zip',
    });
  });

  /**
   * **The span a file covers, where a venue publishes the same period twice.**
   * Two renderings of June differ in what each holds, and that is the whole of
   * what a consumer choosing between them needs — which prefix or host served it
   * is exactly what this catalog absorbs.
   */
  it('says how much time each rendering covers', async () => {
    const items = (await get('/venues/binance/files?dataset=klines&variant=1h')).body.items;

    expect(items.map((one: { path: string; grain: string }) => [one.path, one.grain]))
      .toEqual(expect.arrayContaining([
        ['k/1h/202406/BTCUSDT.zip',   'monthly'],
        ['k/1h/20240601/BTCUSDT.zip', 'daily'],
      ]));
  });

  it('carries the variant where the series has one, and omits it otherwise', async () => {
    const [bar]   = (await get('/venues/binance/files?variant=15m')).body.items;
    const [trade] = (await get('/venues/binance/files?dataset=trades')).body.items;

    expect(bar?.variant).toEqual({ interval: '15m' });
    expect(trade).not.toHaveProperty('variant');
  });
});

/**
 * What is in the catalog at all, which is the question a consumer asks before it
 * wants anything: which bar lengths exist, whether trades are filed monthly or
 * daily, whether there is a venue-wide file or only per-instrument ones.
 */
describe('what this venue publishes', () => {
  const shapes = async (qs = '') =>
    (await get(`/venues/binance/shapes${qs}`)).body.items as unknown as Array<Record<string, unknown>>;

  it('names every shape once, with its grain and its variant', async () => {
    const all = await shapes();

    expect(all.map(one =>
      `${one['dataset']}|${JSON.stringify(one['variant'])}|${one['grain']}`).sort())
      .toEqual([
        'klines|{"interval":"15m"}|monthly',
        'klines|{"interval":"1h"}|daily',
        'klines|{"interval":"1h"}|monthly',
        'trades|{"aggregation":"default"}|monthly',
      ]);
  });

  it('answers what kline intervals there are', async () => {
    expect([...new Set((await shapes('?dataset=klines'))
      .map(one => (one['variant'] as Record<string, string>)['interval']))].sort())
      .toEqual(['15m', '1h']);
  });

  it('answers which renderings a dataset is filed in', async () => {
    expect((await shapes('?dataset=klines&variant=1h')).map(one => one['grain']).sort())
      .toEqual(['daily', 'monthly']);
  });

  it('counts instruments and venue-wide files apart', async () => {
    const [hourly] = await shapes('?dataset=klines&variant=1h&grain=monthly');

    expect(hourly).toMatchObject({ symbols: 2, buckets: 0 });
  });

  it('refuses a grain it does not publish in, rather than answering nothing', async () => {
    const { status } = await get('/venues/binance/shapes?grain=fortnightly');

    expect(status).toBe(400);
  });
});

/**
 * A dataset's levels, named on the way out.
 *
 * The catalog stores them as one string because a path is one string; a consumer
 * choosing between book depths should not be splitting commas and counting
 * positions to find them.
 */
describe('naming a variant\'s levels', () => {
  it('names each level of a multi-level variant', () => {
    expect(levelsOf('books', '400,incremental'))
      .toEqual({ depth: '400', mode: 'incremental' });
  });

  it('names the single level of a simple one', () => {
    expect(levelsOf('klines', '1m')).toEqual({ interval: '1m' });
  });

  it('answers nothing for a dataset with no level below it', () => {
    expect(levelsOf('quotes', '')).toEqual({});
    expect(levelsOf('liquidations', '')).toEqual({});
  });

  /**
   * Most venues publish one flavour of trades and say nothing about whether it
   * is aggregated, so the catalog stores nothing — and reports `default`, which
   * claims only "the one it publishes".
   */
  it('reports the default where a level has one and nothing is stored', () => {
    expect(levelsOf('trades', '')).toEqual({ aggregation: 'default' });
  });

  it('reports what is stored where a venue does say', () => {
    expect(levelsOf('trades', 'aggregated')).toEqual({ aggregation: 'aggregated' });
    expect(levelsOf('trades', 'default')).toEqual({ aggregation: 'default' });
  });

  /** A level nobody has named yet is reported rather than silently dropped. */
  it('gives the last named level whatever is left over', () => {
    expect(levelsOf('books', '400,incremental,surprise'))
      .toEqual({ depth: '400', mode: 'incremental,surprise' });
  });
});
