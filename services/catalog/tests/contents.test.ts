import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { putFiles, putVenue, recordSeries, storeLens, venueIdOf } from './fixture';
import { openScratch } from './fixture';
import { lensScope, throughLens } from '../src/lenses/scope';
import { seriesFor, venueIds } from '../src/queries';
import { lensNamed } from '@tradebot/lenses';
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

  const id = putVenue(db, 'binance', 'https://data.binance.vision', 'data/');

  await publish(id, {}, ['20200101', '20200102', '20210105']);
  await publish(id, { symbol: 'ETHUSDT', urlSymbol: 'ETHUSDT' }, ['20210105', '20210106']);


  app = express();
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

describe('a venue\'s markets', () => {
  beforeEach(async () => {
    const id = venueIdOf(db, 'binance');

    // The same instrument at another bar length, filed by month; and a market whose venue-wide file sits beside an instrument.
    await publish(id, { variant: '1h', pattern: 'k/1h/{YYYY}{MM}/{SYMBOL}.zip' }, ['202001', '202002']);
    await publish(id, { market: 'spot', dataset: 'trades', variant: '', symbol: '@', urlSymbol: '@',
      pattern: 't/{YYYY}{MM}/all-{YYYY}{MM}.zip' }, ['202107']);
    await publish(id, { market: 'spot', dataset: 'trades', variant: '', symbol: 'ADAUSDT', urlSymbol: 'ADAUSDT',
      pattern: 't/{YYYY}{MM}/{SYMBOL}-{YYYY}{MM}.zip' }, ['202107']);
  });

  /**
   * BTCUSDT is in two shapes of perp, and counted once; the venue-wide file is
   * in spot's one shape, and is not an instrument.
   */
  it('names each market\'s datasets, with their variants, grains and instruments', async () => {
    const { status, body } = await call('/venues/binance');

    expect(status).toBe(200);
    expect(body.items).toEqual([
      { market: 'perp', symbols: 2, datasets: [
        { dataset: 'klines', shapes: 2, variants: ['1h', '1m'], grains: ['daily', 'monthly'], symbols: 2 },
      ] },
      { market: 'spot', symbols: 1, datasets: [
        { dataset: 'trades', shapes: 1, variants: ['default'], grains: ['monthly'], symbols: 1 },
      ] },
    ]);
  });

  it('is a 404 for a venue the catalog does not hold', async () => {
    expect((await call('/venues/nowhere')).status).toBe(404);
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

  it('is a 422 for a lens parameter given more than once, never the whole catalog', async () => {
    await lens();

    for (const path of ['/venues', '/venues/binance/symbols', '/venues/binance/partitions']) {
      const { status, body } = await call(`${path}?lens=to-2020&lens=to-2020`);

      expect(status).toBe(422);
      expect(body.error).toBe('The lens parameter may be given once');
    }
  });
});

describe('a query parameter', () => {
  it('is a 400 where it is given more than once', async () => {
    expect(await call('/venues/binance/symbols?grain=daily&grain=daily')).toMatchObject({ status: 400, body: { error: 'grain may be given once' } });
    expect((await call('/venues/binance/markets/perp?dataset=klines&dataset=klines')).status).toBe(400);
    expect((await call('/venues/binance/partitions?market=perp&market=perp')).status).toBe(400);
    expect((await call('/venues/binance/partitions?settled=true&settled=true')).status).toBe(400);
  });
});

/**
 * A lens that carves a hole leaves each slice two spans, and a series is
 * tested against each of them rather than against their outer edges.
 */
describe('the contents through a lens with a hole', () => {
  const HOLED = { 'x-catalog-lens': 'holed' };

  beforeEach(async () => {
    const id = putVenue(db, 'okx', 'https://okx.example', '');

    await publish(id, {}, ['20200101', '20200301', '20200601']);
    await publish(id, { symbol: 'ETHUSDT', urlSymbol: 'ETHUSDT' }, ['20200301']);
    await publish(id, { symbol: 'SOLUSDT', urlSymbol: 'SOLUSDT' }, ['20200115', '20200301']);
  });

  const holed = (...holes: [string, string][]) => storeLens(db, 'holed', '', '', { format: 1, venues: { okx: [
    { effect: 'include' },
    ...holes.map(([from, to]) => ({ effect: 'exclude' as const, from, to })),
  ] } });

  it('leaves out a series whose only file is in the hole', async () => {
    holed(['202002', '202005']);

    expect((await call('/venues/okx/symbols', { headers: HOLED })).body.items).toEqual(['BTCUSDT', 'SOLUSDT']);
  });

  it('counts only the series with a file inside it, in every view', async () => {
    holed(['202002', '202005']);

    const [shape]  = (await call('/venues/okx/markets/perp', { headers: HOLED })).body.items as { symbols: number }[];
    const [market] = (await call('/venues/okx', { headers: HOLED })).body.items as { symbols: number }[];
    const [venue]  = (await call('/venues', { headers: HOLED })).body.items as
      { venue: string; files: number; series: { withFiles: number } }[];

    expect(shape).toMatchObject({ symbols: 2 });
    expect(market).toMatchObject({ symbols: 2 });
    expect(venue).toMatchObject({ venue: 'okx', files: 3, series: { withFiles: 2 } });
  });

  /** Each series as the lens dates it, by symbol. */
  const dated = (exact = true) => {
    const scope = lensScope(db, lensNamed(db, 'holed')!)!;
    const rows  = venueIds(db, 'okx').flatMap(id => seriesFor(db, id));

    return Object.fromEntries(throughLens(db, rows, scope.get('okx')!, exact).map(one => [one.symbol, [one.first, one.last]]));
  };

  /**
   * BTCUSDT has a file on each side of the hole and one in it; SOLUSDT one
   * before it and one in it. The file in the hole dates neither.
   */
  it('dates a series by its first and last file outside the hole', () => {
    holed(['202002', '202005']);

    expect(dated()).toEqual({ BTCUSDT: ['20200101', '20200601'], SOLUSDT: ['20200115', '20200115'] });
  });

  /** ADAUSDT's range reaches June, a span it holds nothing in: its last file is looked for further back. */
  it('looks past a span that holds nothing of the series for its last file', async () => {
    await publish(venueIds(db, 'okx')[0]!, { symbol: 'ADAUSDT', urlSymbol: 'ADAUSDT' }, ['20200115', '20200301', '20200715']);
    holed(['202002', '202005'], ['202007', '202007']);

    expect(dated().ADAUSDT).toEqual(['20200115', '20200115']);
  });

  /** Without reading a file, a series is clamped to the first and last span its range meets. */
  it('clamps each series to the spans it meets where it reads no file', () => {
    holed(['202002', '202005']);

    expect(dated(false)).toEqual({ BTCUSDT: ['20200101', '20200601'], SOLUSDT: ['20200115', '20200131'] });
  });
});

describe('a lens\'s scope', () => {
  /** Two catalogs that hold a lens of the same slug, saved at the same instant and caught up as far. */
  it('is held for the database it was read from, never served for another', async () => {
    const other = openScratch(join(dir, 'other.db'));

    try {
      const id = putVenue(other, 'okx', 'https://okx.example', '');
      const series = recordSeries(other, id, found({}), { first: '20200101', last: '20200101' });

      await putFiles(other, [{ venueId: id, path: 'BTCUSDT/20200101.zip', date: '20200101', size: 10, etag: 'e',
        modified: null, existence: 'confirmed', seriesId: series.id!, seenAt: 'T1' }]);

      for (const one of [db, other]) {
        storeLens(one, 'to-2020', '', '', { format: 1, venues: { '*': [{ effect: 'include', to: '202012' }] } });
        one.prepare("UPDATE lens SET updated_at = '2026-01-01T00:00:00.000Z', partitions_through = 1").run();
      }

      expect([...lensScope(db, lensNamed(db, 'to-2020')!)!.keys()]).toEqual(['binance']);
      expect([...lensScope(other, lensNamed(other, 'to-2020')!)!.keys()]).toEqual(['okx']);
    } finally {
      other.close();
    }
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
    expect((await partitions('?downloaded=1'))[0]!.partitions.map(one => one.month)).toEqual(['202001']);
    expect((await partitions('?downloaded=0'))[0]!.partitions.map(one => one.month)).toEqual(['202001', '202101']);
    expect(await call('/venues/binance/partitions?downloaded=yes')).toMatchObject({ status: 400, body: { error: 'downloaded must be true or false' } });
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

    /** An instant is compared as the catalog holds them, in UTC, whatever offset it was written with. */
    it('takes an instant at any offset, or a bare date', async () => {
      expect(await months('?settled-before=2026-10-01T01:00:00%2B01:00')).toEqual([]);
      expect(await months('?settled-before=2026-10-01T00:00:01-00:00')).toEqual(['202001']);
      expect(await months('?settled-before=2026-10-01T02:00:00%2B01:00')).toEqual(['202001']);
      expect(await months('?settled-before=2026-10-02')).toEqual(['202001']);
    });

    it('refuses what is not an instant, or a time that does not say its offset', async () => {
      for (const before of ['garbage', '2026-13-01', '20261001', '2026-10-02T00:00:00']) {
        expect(await call(`/venues/binance/partitions?settled-before=${before}`))
          .toMatchObject({ status: 400, body: { error: 'settled-before must be an ISO 8601 instant' } });
      }
    });

    it('leaves everything in for a caller that does not ask', async () => {
      run('2020-01-01T00:00:00.000Z');

      expect(await months('')).toEqual(['202001', '202101']);
      expect(await months('?settled=false')).toEqual(['202001', '202101']);
      expect(await months('?settled=0')).toEqual(['202001', '202101']);
    });

    it('takes 1 for yes, and refuses what is neither yes nor no', async () => {
      run('2026-10-03T00:00:00.000Z');

      expect(await months('?settled=1')).toEqual(['202001']);
      expect(await call('/venues/binance/partitions?settled=maybe'))
        .toMatchObject({ status: 400, body: { error: 'settled must be true or false' } });
    });
  });

  it('refuses a grain or a bundle there is no such thing as', async () => {
    expect((await call('/venues/binance/partitions?grain=weekly')).status).toBe(400);
    expect((await call('/venues/binance/partitions?bundle=symbol')).status).toBe(400);
    expect((await call('/venues/nowhere/partitions')).status).toBe(404);
  });
});
