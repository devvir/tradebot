import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { putFiles, putVenue, recordSeries } from '../src/catalog';
import { openCatalog } from '../src/database';
import { setupRoutes } from '../src/api/routes';
import type { Application } from 'express';
import type { CatalogFile, Surveys } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Proving the rollup, and repairing it.
 *
 * **The `month` table is a maintained counter rather than a query**, which is
 * what makes an aggregate over hundreds of millions of files affordable and what
 * makes a write nobody wired invisible. These two endpoints are the answer to
 * that: one says whether the counter still matches the rows, the other makes it.
 *
 * Both read the whole file table, so nothing calls them on a schedule and the UI
 * does not know they exist.
 */

let dir: string;
let db:  DatabaseSync;
let app: Application;
let running: string[];

const seriesOn = (venueId: number): number =>
  recordSeries(db, venueId, {
    market: 'perp', dataset: 'klines', symbol: 'BTCUSDT',
    pattern: 'p/{YYYY}{MM}/{SYMBOL}.zip',
  }).id!;

const file = (path: string, over: Partial<CatalogFile> = {}): CatalogFile => ({
  venueId: 1, path, date: '20250301', size: 10, etag: 'e', modified: null,
  existence: 'confirmed', seenAt: 'T1', seriesId: seriesOn(1), ...over,
});

beforeEach(() => {
  dir     = mkdtempSync(join(tmpdir(), 'rollup-api-'));
  db      = openCatalog(join(dir, 'catalog.db'), { seedData: false });
  running = [];

  putVenue(db, 'binance', 'https://x', '');

  const surveys = {
    venues:   () => ['binance', 'gate'],
    running:  (venue: string) => running.includes(venue),
    stopping: () => false,
    passing:  () => false,
    everyMs:  () => 86_400_000,
  } as unknown as Surveys;

  app = express();
  app.use(express.json());
  setupRoutes(app, db, surveys);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ask = async <T>(method: 'GET' | 'POST', path: string): Promise<{ status: number; body: T }> => {
  const server = app.listen(0);
  const port   = (server.address() as { port: number }).port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });

    return { status: res.status, body: await res.json() as T };
  } finally {
    server.close();
  }
};

describe('proving and repairing the rollup', () => {
  it('reports nothing where the counter matches the rows', async () => {
    await putFiles(db, [file('spot/a-2025-03.zip')]);

    const { status, body } = await ask<{ items: unknown[] }>('GET', '/months/drift');

    expect(status).toBe(200);
    expect(body.items).toEqual([]);
  });

  it('reports both figures where they disagree', async () => {
    await putFiles(db, [file('spot/a-2025-03.zip')]);
    db.prepare('UPDATE month SET files = 99').run();

    const { body } = await ask<{ items: { files: number; cachedFiles: number }[] }>(
      'GET', '/months/drift');

    expect(body.items).toMatchObject([{ files: 1, cachedFiles: 99 }]);
  });

  it('repairs the counter and says what it repaired', async () => {
    await putFiles(db, [file('spot/a-2025-03.zip')]);
    db.prepare('UPDATE month SET files = 99').run();

    const { status, body } = await ask<{ repaired: number }>('POST', '/months/rebuild');

    expect(status).toBe(200);
    expect(body.repaired).toBe(1);
    expect(db.prepare('SELECT files FROM month').get()).toEqual({ files: 1 });
  });

  /**
   * **A recount walks every file row while a pass is adding to them**, so the
   * figure it commits was true somewhere in the middle and is true of nothing by
   * the end. It is refused rather than raced.
   */
  it('refuses to recount while a venue is still surveying', async () => {
    await putFiles(db, [file('spot/a-2025-03.zip')]);
    db.prepare('UPDATE month SET files = 99').run();

    running = ['gate'];

    const { status, body } = await ask<{ error: string }>('POST', '/months/rebuild');

    expect(status).toBe(409);
    expect(body.error).toContain('gate');

    // And it changed nothing.
    expect(db.prepare('SELECT files FROM month').get()).toEqual({ files: 99 });
  });

  it('names every venue that is holding it up', async () => {
    running = ['binance', 'gate'];

    const { body } = await ask<{ error: string }>('POST', '/months/rebuild');

    expect(body.error).toContain('binance');
    expect(body.error).toContain('gate');
  });
});
