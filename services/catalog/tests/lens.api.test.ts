import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { putVenue, recordSeries } from './fixture';
import { openScratch } from './fixture';
import { mountLenses } from '../src/api/lenses';
import type { Application } from 'express';
import type { Lens, LensDefinition, LensProblem } from '../src/types';
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lens-api-'));
  db  = openScratch(join(dir, 'catalog.db'));

  const venue = putVenue(db, 'binance', 'https://x', '');

  recordSeries(db, venue, { market: 'spot', dataset: 'trades', symbol: 'BTCUSDT',
    pattern: 'spot/trades/{SYMBOL}/{YYYY}{MM}{DD}.zip' });
  recordSeries(db, venue, { market: 'spot', dataset: 'books', symbol: 'BTCUSDT',
    pattern: 'spot/books/{SYMBOL}/{YYYY}{MM}{DD}.zip' });

  app = express();
  app.use(express.json());
  mountLenses(app, db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

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
  it('will not store one that names what the venue does not publish', async () => {
    await ask('POST', '/lenses', { slug: 'cold-store' });

    const { status, body } = await ask<{ problems: LensProblem[] }>(
      'PUT', '/lenses/cold-store',
      { definition: lens({ binance: [{ effect: 'include', datasets: [{ dataset: 'funding' }] }] }) });

    expect(status).toBe(400);
    expect(body.problems[0]).toMatchObject({ venue: 'binance', field: 'datasets' });
  });

  /** The editor asks on every keystroke, so this takes the document rather than a name. */
  it('says what is wrong without storing anything', async () => {
    const { body } = await ask<{ problems: LensProblem[] }>('POST', '/lenses/check',
      lens({ binance: [{ effect: 'exclude', datasets: [{ dataset: 'books' }] }] }));

    expect(body.problems[0]).toMatchObject({ rule: 0 });
    expect((await ask<{ items: Lens[] }>('GET', '/lenses')).body.items).toHaveLength(0);
  });
});

describe('what a definition would select', () => {
  it('sizes one that has not been stored', async () => {
    const { status, body } = await ask<{ series: number }>('POST', '/lenses/size',
      lens({ binance: [{ effect: 'include', datasets: [{ dataset: 'trades' }] }] }));

    expect(status).toBe(200);
    expect(body.series).toBe(1);
  });

  it('says what it selects, by venue', async () => {
    const { body } = await ask<{ venues: Record<string, { series: number; spans: string[] }> }>(
      'POST', '/lenses/resolve',
      lens({ binance: [{ effect: 'include', to: '20201231' }] }));

    expect(body.venues['binance']).toMatchObject({ series: 2, spans: ['..20201231'] });
  });

  it('offers what a venue publishes', async () => {
    const { body } = await ask<{ items: { dataset: string }[] }>('GET', '/lenses/options/binance');

    expect(body.items.map(one => one.dataset).sort()).toEqual(['books', 'trades']);
  });
});
