import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dropLens, lensNamed } from '@tradebot/lenses';
import { changeLens, putFiles, putVenue, recordSeries, storeLens } from './fixture';
import { openScratch } from './fixture';
import { mountLenses } from '../src/api/lenses';
import type { Application } from 'express';
import type { Lens, LensDefinition, LensProblem, LensWrite } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The lens endpoints, over HTTP, against a real catalog.
 *
 * **The rule is tested next door**, in `lens.test.ts`; what is tested here is the
 * part only a request exercises — the status a refusal comes back with, a name
 * already taken, and a definition that answers before it is stored.
 */

let dir: string;
let db:  DatabaseSync;
let app: Application;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lens-api-'));
  db  = openScratch(join(dir, 'catalog.db'));

  const venue = putVenue(db, 'binance', 'https://x', '');

  const trades = recordSeries(db, venue, { market: 'spot', dataset: 'trades', symbol: 'BTCUSDT',
    pattern: 'spot/trades/{SYMBOL}/{YYYY}{MM}{DD}.zip' });

  await putFiles(db, [
    { venueId: venue, seriesId: trades.id, path: 'a', date: '20200101' },
    { venueId: venue, seriesId: trades.id, path: 'b', date: '20210101' },
  ]);

  recordSeries(db, venue, { market: 'spot', dataset: 'books', symbol: 'BTCUSDT',
    pattern: 'spot/books/{SYMBOL}/{YYYY}{MM}{DD}.zip' });

  app = express();
  app.use(express.json());
  mountLenses(app, db);

  // Anything sent to prospector is answered by a stand-in; everything else is a real request.
  const real = globalThis.fetch;

  forwarded = [];

  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) =>
    (String(url).startsWith('http://prospector:8080') ? prospector(String(url), init) : real(url, init)));
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** What the catalog handed to prospector, as `METHOD path`. */
let forwarded: string[];

/**
 * Prospector, as far as storing a lens goes: the one thing that writes, here
 * writing to the test's own database.
 */
const prospector = async (url: string, init?: RequestInit): Promise<Response> => {
  const path   = new URL(url).pathname;
  const method = init?.method ?? 'GET';
  const body   = (init?.body ? JSON.parse(String(init.body)) : {}) as LensWrite;
  const slug   = decodeURIComponent(path.split('/')[2] ?? '');
  const json   = (status: number, value: unknown): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

  forwarded.push(`${method} ${path}`);

  if (method === 'POST') {
    const made = storeLens(db, body.slug!, body.name ?? '', body.note ?? '', body.definition);

    return made ? json(201, made) : json(409, { error: 'taken' });
  }

  if (method === 'PUT') {
    const saved = changeLens(db, slug, body);

    return saved ? json(200, saved) : json(lensNamed(db, slug) ? 409 : 404, { error: 'refused' });
  }

  return dropLens(db, slug) ? new Response(null, { status: 204 }) : json(404, { error: 'No such lens' });
};

const ask = async <T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path:   string,
  body?:  unknown,
): Promise<{ status: number; body: T }> => {
  const server = app.listen(0);
  const port   = (server.address() as { port: number }).port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: res.status, body: await res.json().catch(() => ({})) as T };
  } finally {
    server.close();
  }
};

const lens = (venues: LensDefinition['venues']): LensDefinition => ({ format: 1, venues });

describe('keeping a lens', () => {
  it('makes one, lists it, and gives it back by name', async () => {
    const made = await ask<Lens>('POST', '/lenses', { slug: 'cold-store', name: 'Cold store', note: 'old things' });

    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ slug: 'cold-store', name: 'Cold store', note: 'old things' });

    expect((await ask<{ items: Lens[] }>('GET', '/lenses')).body.items).toHaveLength(1);
    expect((await ask<Lens>('GET', '/lenses/cold-store')).status).toBe(200);
  });

  it('refuses a name already taken', async () => {
    await ask('POST', '/lenses', { slug: 'cold-store' });

    expect((await ask('POST', '/lenses', { slug: 'cold-store' })).status).toBe(409);
  });

  it('refuses a name a consumer would have to quote', async () => {
    expect((await ask('POST', '/lenses', { slug: 'Cold Store' })).status).toBe(400);
  });

  it('answers 404 for a lens nobody made', async () => {
    expect((await ask('GET', '/lenses/nothing')).status).toBe(404);
    expect((await ask('DELETE', '/lenses/nothing')).status).toBe(404);
  });

  it('replaces the whole definition', async () => {
    await ask('POST', '/lenses', { slug: 'cold-store' });

    const to = lens({ binance: [{ effect: 'include', datasets: [{ dataset: 'trades' }] }] });
    const saved = await ask<Lens>('PUT', '/lenses/cold-store', { definition: to });

    expect(saved.status).toBe(200);
    expect(saved.body.definition).toEqual(to);
  });

  it('takes one away', async () => {
    await ask('POST', '/lenses', { slug: 'cold-store' });

    expect((await ask('DELETE', '/lenses/cold-store')).status).toBe(204);
    expect((await ask('GET', '/lenses/cold-store')).status).toBe(404);
  });
});

describe('refusing a definition', () => {
  it('will not store one that is not a rule', async () => {
    await ask('POST', '/lenses', { slug: 'cold-store' });

    const { status, body } = await ask<{ problems: LensProblem[] }>(
      'PUT', '/lenses/cold-store',
      { definition: lens({ binance: [{ effect: 'include', from: '2020-06' }] }) });

    expect(status).toBe(400);
    expect(body.problems[0]).toMatchObject({ venue: 'binance', field: 'from' });
  });

  /** The editor asks on every keystroke, so this takes the document rather than a name. */
  it('says what is wrong without storing anything', async () => {
    const { body } = await ask<{ problems: LensProblem[] }>('POST', '/lenses/check',
      lens({ nowhere: [{ effect: 'include' }] }));

    expect(body.problems[0]).toMatchObject({ venue: 'nowhere', rule: -1 });
    expect((await ask<{ items: Lens[] }>('GET', '/lenses')).body.items).toHaveLength(0);
  });
});

describe('what a definition would select', () => {
  it('sizes one that has not been stored', async () => {
    const { status, body } = await ask<{ partitions: number; files: number }>('POST', '/lenses/size',
      lens({ binance: [{ effect: 'include', datasets: [{ dataset: 'trades' }] }] }));

    expect(status).toBe(200);
    expect(body).toMatchObject({ partitions: 2, files: 2 });
  });

  it('says what it selects, by venue', async () => {
    const { body } = await ask<{ venues: Record<string, { slices: number; partitions: number; spans: string[] }> }>(
      'POST', '/lenses/resolve',
      lens({ binance: [{ effect: 'include', to: '202012' }] }));

    // Both slices are let through; only one month of one of them holds anything.
    expect(body.venues['binance']).toEqual({ slices: 2, partitions: 1, spans: ['..202012'] });
  });

  it('offers what the venues publish, each combination with the venue it is of', async () => {
    const { body } = await ask<{ items: { venue: string; dataset: string }[] }>('GET', '/lenses/options');

    expect([...new Set(body.items.filter(one => one.venue === 'binance').map(one => one.dataset))].sort()).toEqual(['books', 'trades']);
  });
});

/**
 * This service reads the catalog and never writes it: whatever it is sent to be
 * stored is prospector's to store.
 */
describe('storing a lens', () => {
  it('hands every write to prospector, and answers what it answered', async () => {
    await ask('POST', '/lenses', { slug: 'cold-store', definition: lens({ binance: [{ effect: 'include' }] }) });
    await ask('PUT', '/lenses/cold-store', { note: 'what is old' });
    await ask('DELETE', '/lenses/cold-store');

    expect(forwarded).toEqual(['POST /lenses', 'PUT /lenses/cold-store', 'DELETE /lenses/cold-store']);
  });

  it('hands nothing over that it refused itself', async () => {
    await ask('POST', '/lenses', { slug: 'Not Sound' });
    await ask('POST', '/lenses', { slug: 'cold-store', definition: lens({ nowhere: [{ effect: 'include' }] }) });

    expect(forwarded).toEqual([]);
  });

  it('says so where prospector is not answering', async () => {
    const real = globalThis.fetch;

    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('http://prospector:8080')) throw new TypeError('fetch failed');

      return real(url, init);
    });

    const made = await ask<{ error: string }>('POST', '/lenses', { slug: 'cold-store' });

    expect(made.status).toBe(502);
  });
});
