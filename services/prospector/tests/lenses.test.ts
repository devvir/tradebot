import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { putFiles, putVenue, recordSeries } from '../src/catalog';
import { openCatalog } from '../src/database';
import { mount } from '../src/api';
import { _test_settleMs as settleMs, keepLensesCurrent } from '../src/lenses';
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

  // The wait after a save is for a person changing several rules; nothing here is about how long it is.
  settleMs(20);

  stop = keepLensesCurrent(db);
});

afterEach(() => {
  stop();
  settleMs(null);
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

  for (let turn = 0; turn < 400 && updating(); turn++) await new Promise(done => setTimeout(done, 10));
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

  /** Rules are stored one at a time: a run of saves is worked out once, as the last of them left it. */
  it('works a run of saves out as the last one left the lens', async () => {
    // Longer than the three requests take between them, as the service's wait is longer than a person takes.
    settleMs(1_000);

    await ask('POST', '/lenses', { slug: 'everything', definition: all });
    await ask('PUT', '/lenses/everything', { definition: old });
    await ask('PUT', '/lenses/everything', { definition: { format: 1, venues: { gate: [{ effect: 'include' }] } } });

    expect(members('everything')).toEqual([]);

    await settled('everything');

    expect(members('everything')).toEqual(['gate 202001']);
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
  /** In the transaction that makes it: there is no moment at which the partition exists and the lens has not seen it. */
  it('takes a partition into its lenses as it is made', async () => {
    await ask('POST', '/lenses', { slug: 'everything', definition: all });
    await ask('POST', '/lenses', { slug: 'old', definition: old });
    await settled('everything');
    await settled('old');

    await putFiles(db, [file(2, 'h.zip', '20220101')]);

    expect(members('everything')).toEqual(['binance 202001', 'binance 202101', 'gate 202001', 'gate 202201']);
    expect(members('old')).toEqual(['binance 202001', 'gate 202001']);

    // And the lens knows it has read it: nothing is left for a round to find.
    expect(db.prepare('SELECT partitions_through = (SELECT MAX(id) FROM partition) AS caught FROM lens WHERE slug = ?').get('everything'))
      .toEqual({ caught: 1 });
  });

  /** A lens whose rules were just saved is worked out whole, the new partition with the rest. */
  it('leaves a lens that is being worked out to the pass that does it', async () => {
    settleMs(1_000);

    await ask('POST', '/lenses', { slug: 'everything', definition: all });
    await putFiles(db, [file(2, 'h.zip', '20220101')]);

    expect(members('everything')).toEqual([]);

    await settled('everything');

    expect(members('everything')).toEqual(['binance 202001', 'binance 202101', 'gate 202001', 'gate 202201']);
  });
});
