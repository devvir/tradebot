import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { putFiles, putVenue, recordSeries } from '../src/catalog';
import { openCatalog } from '../src/database';
import { mount } from '../src/api';
import { keepLensesCurrent } from '../src/lenses';
import type { Application } from 'express';
import type { CatalogFile, Surveys } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Storing a lens, and keeping what it lets through current — both here because
 * both are writes, and this service is the only writer of the catalog database.
 */

let dir: string;
let db:  DatabaseSync;
let app: Application;

/** Ends the background working out of the lenses, started for every test as the service starts it. */
let stop: () => void;

const file = (venueId: number, path: string, date: string): CatalogFile => ({
  venueId, path, date, size: 10, etag: 'e', modified: null,
  existence: 'confirmed', seenAt: 'T1',
  seriesId: recordSeries(db, venueId, {
    market: 'perp', dataset: 'klines', symbol: 'BTCUSDT', pattern: 'p/{YYYY}{MM}/{SYMBOL}.zip',
  }).id!,
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lenses-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });

  putVenue(db, 'binance', 'https://x', '');
  putVenue(db, 'gate', 'https://g', '');

  await putFiles(db, [file(1, 'a.zip', '20200101'), file(1, 'b.zip', '20210101')]);
  await putFiles(db, [file(2, 'g.zip', '20200101')]);

  app = express();
  app.use(express.json());
  mount(app, db, '', { venues: () => ['binance', 'gate'] } as unknown as Surveys);

  stop = keepLensesCurrent(db);
});

afterEach(() => {
  stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ask = async (method: string, path: string, body?: unknown) => {
  const server = app.listen(0);
  const port   = (server.address() as { port: number }).port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> | null };
  } finally {
    server.close();
  }
};

/** What a lens lets through, as `venue month`. */
const members = (slug: string): string[] =>
  (db.prepare(
    `SELECT c.venue || ' ' || q.month AS at
       FROM lens l
       JOIN lens_member m ON m.lens_id = l.id
       JOIN partition q   ON q.id = m.partition_id
       JOIN slice c       ON c.id = q.slice_id
      WHERE l.slug = ? ORDER BY 1`,
  ).all(slug) as { at: string }[]).map(one => one.at);

/** Wait, a turn of the write queue at a time, for the background to finish working a lens out. */
const settled = async (slug: string): Promise<void> => {
  const updating = (): boolean =>
    (db.prepare('SELECT rebuilding FROM lens WHERE slug = ?').get(slug) as { rebuilding: number } | undefined)?.rebuilding === 1;

  for (let turn = 0; turn < 500 && updating(); turn++) await new Promise(done => setImmediate(done));
};

const all  = { format: 1, venues: { '*': [{ effect: 'include' }] } };
const old  = { format: 1, venues: { '*': [{ effect: 'include', to: '202012' }] } };

describe('storing a lens', () => {
  /** The answer is that it was stored; what it lets through is worked out after, without being asked for. */
  it('makes one and answers at once, then works out what it lets through', async () => {
    const made = await ask('POST', '/lenses', { slug: 'everything', definition: all });

    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ slug: 'everything', definition: all, updating: true });

    await settled('everything');

    expect(members('everything')).toEqual(['binance 202001', 'binance 202101', 'gate 202001']);
  });

  it('refuses a slug already taken', async () => {
    await ask('POST', '/lenses', { slug: 'everything', definition: all });

    expect((await ask('POST', '/lenses', { slug: 'everything', definition: all })).status).toBe(409);
  });

  it('replaces one, and what it lets through with it', async () => {
    await ask('POST', '/lenses', { slug: 'everything', definition: all });

    await settled('everything');

    const saved = await ask('PUT', '/lenses/everything', { definition: old });

    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ updating: true });

    await settled('everything');

    expect(members('everything')).toEqual(['binance 202001', 'gate 202001']);
    expect((await ask('PUT', '/lenses/nobody', { note: 'x' })).status).toBe(404);
  });

  it('removes one, and its members', async () => {
    await ask('POST', '/lenses', { slug: 'everything', definition: all });
    await settled('everything');

    expect((await ask('DELETE', '/lenses/everything')).status).toBe(204);
    expect(db.prepare('SELECT count(*) AS n FROM lens_member').get()).toEqual({ n: 0 });
    expect((await ask('DELETE', '/lenses/everything')).status).toBe(404);
  });
});

describe('keeping the lenses current', () => {
  /** A partition that arrives after a lens was saved is folded in without anybody asking through the lens. */
  it('folds in the partitions that appeared since a lens was stored', async () => {
    await ask('POST', '/lenses', { slug: 'everything', definition: all });
    await settled('everything');
    await putFiles(db, [file(2, 'h.zip', '20220101')]);

    expect(members('everything')).not.toContain('gate 202201');

    // A round is what the timer runs; saving any lens starts one at once.
    await ask('POST', '/lenses', { slug: 'another', definition: old });

    for (let turn = 0; turn < 500 && ! members('everything').includes('gate 202201'); turn++)
      await new Promise(done => setImmediate(done));

    expect(members('everything')).toEqual(['binance 202001', 'binance 202101', 'gate 202001', 'gate 202201']);
  });
});
