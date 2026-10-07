import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { putFiles, putVenue, recordSeries, storeLens } from './fixture';
import { _test_scopes } from '../src/lenses/scope';
import { openScratch } from './fixture';
import { mount } from '../src/api';
import type { Application } from 'express';
import type { SeriesSpec as Found } from './types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The contents views through a lens: only what it lets through, with dates read
 * off the files inside it.
 */

let dir: string;
let db:  DatabaseSync;
let app: Application;

const found = (over: Partial<Found>): Found => ({
  market: 'perp', dataset: 'klines', variant: '1m', symbol: 'BTCUSDT', urlSymbol: 'BTCUSDT',
  pattern: 'k/1m/{YYYY}{MM}{DD}/{SYMBOL}.zip', ...over,
});

const publish = async (id: number, over: Partial<Found>, dates: string[]) => {
  const series = recordSeries(db, id, found(over), { first: dates[0]!, last: dates.at(-1)! });

  await putFiles(db, dates.map(date => ({
    venueId: id, path: `${over.symbol ?? 'BTCUSDT'}/${date}.zip`, date, size: 10, etag: 'e', modified: null,
    existence: 'confirmed' as const, seriesId: series.id!, seenAt: 'T1',
  })));
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'contents-'));
  db  = openScratch(join(dir, 'catalog.db'));
  _test_scopes.clear();

  const id = putVenue(db, 'binance', 'https://data.binance.vision', 'data/');

  await publish(id, {}, ['20200101', '20200102', '20210105']);
  await publish(id, { symbol: 'ETHUSDT', urlSymbol: 'ETHUSDT' }, ['20210105', '20210106']);


  app = express();
  app.use(express.json());
  mount(app, db, '');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (path: string, init: RequestInit = {}) => {
  const server = app.listen(0);
  const port   = (server.address() as { port: number }).port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });

    return { status: res.status, body: await res.json() as { items: never[]; error?: string } };
  } finally {
    server.close();
  }
};

const LENS = { 'x-catalog-lens': 'to-2020' };

/** A lens in the catalog, as prospector stores one: this service only reads through it. */
const lens = () => storeLens(db, 'to-2020', '', '', { format: 1, venues: { '*': [{ effect: 'include', to: '202012' }] } });

describe('where a venue\'s files are served from', () => {
  /** The address that is listed, then whatever else serves the same files — each ending where a path begins. */
  it('lists the main address first and its alternatives after it, the key root applied to each', async () => {
    db.prepare(`UPDATE venue SET alternative_hosts = '["https://mirror.example/"]' WHERE name = 'binance'`).run();

    const [venue] = (await call('/venues')).body.items as { hosts: Record<string, string[]> }[];

    expect(venue!.hosts).toEqual({ '': ['https://data.binance.vision/data/', 'https://mirror.example/data/'] });
    expect(venue).not.toHaveProperty('alternative_hosts');
  });

  it('names each server of a venue that has two', async () => {
    putVenue(db, 'binance', 'https://books.example', 'orderbook/', 'secondary');

    const [venue] = (await call('/venues')).body.items as { hosts: Record<string, string[]> }[];

    expect(venue!.hosts).toEqual({
      '': ['https://data.binance.vision/data/'], secondary: ['https://books.example/orderbook/'],
    });
  });
});

describe('the contents through a lens', () => {
  it('lists only instruments with a file inside it', async () => {
    await lens();

    expect((await call('/venues/binance/symbols')).body.items).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect((await call('/venues/binance/symbols', { headers: LENS })).body.items).toEqual(['BTCUSDT']);
  });

  /** The newest file inside the lens, not the lens's own last day. */
  it('dates a shape by the files inside it', async () => {
    await lens();

    const [shape] = (await call('/venues/binance/markets/perp', { headers: LENS })).body.items as
      { first: string; last: string; symbols: number }[];

    expect(shape).toMatchObject({ first: '20200101', last: '20200102', symbols: 1 });
  });

  it('totals a venue as the lens sees it', async () => {
    await lens();

    const [venue] = (await call('/venues', { headers: LENS })).body.items as
      { files: number; firstMonth: string; lastMonth: string; series: { total: number } }[];

    expect(venue).toMatchObject({ files: 2, firstMonth: '202001', lastMonth: '202001', series: { total: 1 } });
  });

  /**
   * A lens that carves a hole gives each series two spans, so each sits in two of
   * the groups its figures are summed over — and must still be counted once.
   */
  it('counts a series with two spans once', async () => {
    storeLens(db, 'holed', '', '', { format: 1, venues: { binance: [
      { effect: 'include' },
      { effect: 'exclude', from: '202006', to: '202012' },
    ] } });

    const [venue] = (await call('/venues', { headers: { 'x-catalog-lens': 'holed' } })).body.items as
      { files: number; firstMonth: string; lastMonth: string; series: { withFiles: number } }[];

    expect(venue).toMatchObject({ files: 5, firstMonth: '202001', lastMonth: '202101', series: { withFiles: 2 } });
  });

  it('is a 422 for a lens that does not exist, never the whole catalog', async () => {
    expect((await call('/venues/binance/symbols', { headers: { 'x-catalog-lens': 'nope' } })).status)
      .toBe(422);
  });
});

/**
 * A venue's partitions: each slice once, its months inside it, each with its
 * own counts and version.
 */
describe('a venue\'s partitions', () => {
  interface Held {
    market: string; dataset: string; variant: string; grain: string; bundle: string;
    partitions: { month: string; files: number; pending: number; version: string; updatedAt: string }[];
  }

  const partitions = async (query = '', headers: Record<string, string> = {}): Promise<Held[]> =>
    (await call(`/venues/binance/partitions${query}`, { headers })).body.items as unknown as Held[];

  /** Two instruments of one slice share its partitions. */
  it('nests each slice\'s months under it', async () => {
    expect(await partitions()).toMatchObject([{
      market: 'perp', dataset: 'klines', variant: '1m', grain: 'daily', bundle: 'instrument',
      partitions: [{ month: '202001', files: 2, pending: 2 }, { month: '202101', files: 3, pending: 3 }],
    }]);
  });

  it('gives each partition a version and when it last moved', async () => {
    const [slice] = await partitions();

    expect(slice!.partitions[0]).toMatchObject({ version: expect.stringMatching(/^[0-9a-f]{16}$/), updatedAt: 'T1' });
  });

  it('shows only what a lens lets through', async () => {
    await lens();

    expect((await partitions('', LENS))[0]!.partitions.map(one => one.month)).toEqual(['202001']);
  });

  /** A slice none of whose partitions were asked for is not listed empty. */
  it('narrows by dataset, and leaves out a slice left with nothing', async () => {
    const id = (db.prepare('SELECT id FROM venue').get() as { id: number }).id;

    await publish(id, { dataset: 'trades', variant: '', symbol: 'SOLUSDT', urlSymbol: 'SOLUSDT', pattern: 't/{YYYY}{MM}{DD}/{SYMBOL}.zip' }, ['20200101']);

    expect((await partitions()).map(one => one.dataset)).toEqual(['klines', 'trades']);
    expect((await partitions('?datasets=trades,funding')).map(one => one.dataset)).toEqual(['trades']);
    expect(await partitions('?datasets=funding')).toEqual([]);
  });

  it('narrows to what is fully downloaded', async () => {
    expect(await partitions('?downloaded=true')).toEqual([]);

    db.exec(`UPDATE partition SET pending = 0 WHERE month = '202001'`);

    expect((await partitions('?downloaded=true'))[0]!.partitions.map(one => one.month)).toEqual(['202001']);
  });

  describe('narrowed to what is settled', () => {
    const months = async (query: string): Promise<string[]> =>
      (await partitions(query)).flatMap(slice => slice.partitions.map(one => one.month));

    const venueId = (): number => (db.prepare('SELECT id FROM venue').get() as { id: number }).id;

    const run = (started: string, completed: string | null = null, venue = venueId()): void => {
      db.prepare(`INSERT INTO run (venue_id, kind, scope, started, completed) VALUES (?, 'walk', '', ?, ?)`)
        .run(venue, started, completed);
    };

    /** yyyymm of the month `days` ago, as the catalog counts it. */
    const monthAgo = (days: number): string =>
      new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 7).replace('-', '');

    beforeEach(() => {
      db.exec(`UPDATE partition SET updated_at = '2026-10-01T00:00:00.000Z' WHERE month = '202001'`);
      db.exec(`UPDATE partition SET updated_at = '2026-10-04T00:00:00.000Z' WHERE month = '202101'`);
    });

    it('takes an old month no run is at work on as settled', async () => {
      expect(await months('?settled')).toEqual(['202001', '202101']);
      expect(await months('?settled=true')).toEqual(['202001', '202101']);
    });

    /** A venue goes on publishing a period after it closes. */
    it('never takes a month that is running, or that closed only days ago', async () => {
      db.prepare(`UPDATE partition SET month = ? WHERE month = '202101'`).run(monthAgo(0));
      expect(await months('?settled')).toEqual(['202001']);

      db.prepare(`UPDATE partition SET month = ? WHERE month = ?`).run(monthAgo(14), monthAgo(0));
      expect(await months('?settled')).toEqual(['202001']);

      db.prepare(`UPDATE partition SET month = ? WHERE month = ?`).run(monthAgo(50), monthAgo(14));
      expect(await months('?settled')).toEqual(['202001', monthAgo(50)]);
    });

    /** The run that changed it may not be done with it. */
    it('leaves out what a run still open has changed', async () => {
      run('2026-10-03T00:00:00.000Z');

      expect(await months('?settled')).toEqual(['202001']);
    });

    it('takes it back once that run completes', async () => {
      run('2026-10-03T00:00:00.000Z', '2026-10-05T00:00:00.000Z');

      expect(await months('?settled')).toEqual(['202001', '202101']);
    });

    it('counts the open run of any host of the venue, and of no other venue', async () => {
      const other = putVenue(db, 'binance', 'https://books.binance.test', '', 'secondary');
      const else_ = putVenue(db, 'okx', 'https://okx.test');

      run('2026-09-01T00:00:00.000Z', null, else_);
      expect(await months('?settled')).toEqual(['202001', '202101']);

      run('2026-10-03T00:00:00.000Z', null, other);
      expect(await months('?settled')).toEqual(['202001']);
    });

    /** What a consumer waiting for a partition to go quiet asks with. */
    it('narrows further to what had gone quiet by an instant', async () => {
      expect(await months('?settled-before=2026-10-02T00:00:00.000Z')).toEqual(['202001']);
      expect(await months('?settled-before=2026-09-01T00:00:00.000Z')).toEqual([]);
    });

    it('holds an instant to the settled rule as well', async () => {
      run('2026-09-15T00:00:00.000Z');

      expect(await months('?settled-before=2026-10-02T00:00:00.000Z')).toEqual([]);

      db.prepare(`UPDATE partition SET month = ? WHERE month = '202001'`).run(monthAgo(0));
      db.exec('DELETE FROM run');

      expect(await months('?settled-before=2026-10-02T00:00:00.000Z')).toEqual([]);
    });

    it('leaves everything in for a caller that does not ask', async () => {
      run('2020-01-01T00:00:00.000Z');

      expect(await months('')).toEqual(['202001', '202101']);
      expect(await months('?settled=false')).toEqual(['202001', '202101']);
    });
  });

  it('refuses a grain or a bundle there is no such thing as', async () => {
    expect((await call('/venues/binance/partitions?grain=weekly')).status).toBe(400);
    expect((await call('/venues/binance/partitions?bundle=symbol')).status).toBe(400);
    expect((await call('/venues/nowhere/partitions')).status).toBe(404);
  });
});
