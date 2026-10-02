import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { putFiles, putVenue, recordSeries } from '../src/catalog';
import { _test_scopes } from '../src/catalog/scope';
import { openCatalog } from '../src/database';
import { mount } from '../src/api';
import type { Application } from 'express';
import type { Found, Surveys } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The contents views through a lens: only what it lets through, with dates read
 * off the files inside it, and nothing still "open" once the lens has ended.
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
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });
  _test_scopes.clear();

  const id = putVenue(db, 'binance', 'https://data.binance.vision', 'data/');

  await publish(id, {}, ['20200101', '20200102', '20210105']);
  await publish(id, { symbol: 'ETHUSDT', urlSymbol: 'ETHUSDT' }, ['20210105', '20210106']);

  const surveys: Surveys = {
    venues: () => ['binance'], start: () => undefined, running: () => false,
    passing: () => false, paused: () => false, pause: () => false,
  };

  app = express();
  app.use(express.json());
  mount(app, db, '', surveys);
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

const lens = () => call('/lenses', { method: 'POST', body: JSON.stringify({
  slug: 'to-2020', definition: { format: 1, venues: { '*': [{ effect: 'include', to: '202012' }] } },
}) });

describe('the contents through a lens', () => {
  it('lists only instruments with a file inside it', async () => {
    await lens();

    expect((await call('/contents/venues/binance/symbols')).body.items).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect((await call('/contents/venues/binance/symbols', { headers: LENS })).body.items).toEqual(['BTCUSDT']);
  });

  /** The newest file inside the lens, not the lens's own last day. */
  it('dates a shape by the files inside it, and calls it closed once the lens has ended', async () => {
    await lens();

    const [shape] = (await call('/contents/venues/binance/markets/perp', { headers: LENS })).body.items as
      { first: string; last: string; open: boolean; symbols: number }[];

    expect(shape).toMatchObject({ first: '20200101', last: '20200102', open: false, symbols: 1 });
  });

  it('totals a venue as the lens sees it', async () => {
    await lens();

    const [venue] = (await call('/contents/venues', { headers: LENS })).body.items as
      { files: number; firstMonth: string; lastMonth: string; series: { total: number } }[];

    expect(venue).toMatchObject({ files: 2, firstMonth: '202001', lastMonth: '202001', series: { total: 1 } });
  });

  it('is a 404 for a lens that does not exist, never the whole catalog', async () => {
    expect((await call('/contents/venues/binance/symbols', { headers: { 'x-catalog-lens': 'nope' } })).status)
      .toBe(404);
  });
});
