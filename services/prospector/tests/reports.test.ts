import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { putFiles, putVenue, recordSeries } from '../src/catalog';
import { openCatalog } from '../src/database';
import { mount } from '../src/api';
import type { Application } from 'express';
import type { CatalogFile, Surveys } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * A report names files by `FileId`, the file's rowid, and is settled against the
 * venue in the path: an id from another venue, or one that names nothing, is
 * counted as unknown rather than written.
 */

let dir: string;
let db:  DatabaseSync;
let app: Application;

const file = (venueId: number, path: string): CatalogFile => ({
  venueId, path, date: '20250301', size: 10, etag: 'e', modified: null,
  existence: 'confirmed', seenAt: 'T1',
  seriesId: recordSeries(db, venueId, {
    market: 'perp', dataset: 'klines', symbol: 'BTCUSDT', pattern: 'p/{YYYY}{MM}/{SYMBOL}.zip',
  }).id!,
});

/** The FileId the catalog gave a path. */
const idOf = (path: string): number =>
  Number((db.prepare('SELECT rowid AS id FROM file WHERE path = ?').get(path) as { id: number }).id);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reports-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });

  putVenue(db, 'binance', 'https://x', '');
  putVenue(db, 'gate', 'https://g', '');

  await putFiles(db, [file(1, 'a.zip'), file(1, 'b.zip')]);
  await putFiles(db, [file(2, 'g.zip')]);

  app = express();
  app.use(express.json());
  mount(app, db, '', { venues: () => ['binance', 'gate'] } as unknown as Surveys);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const report = async (venue: string, body: unknown) => {
  const server = app.listen(0);
  const port   = (server.address() as { port: number }).port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/reports/${venue}`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify(body),
    });

    return { status: res.status, body: await res.json() as Record<string, unknown> };
  } finally {
    server.close();
  }
};

const downloadedAt = (path: string): string | null =>
  (db.prepare('SELECT downloaded_at AS at FROM file WHERE path = ?').get(path) as { at: string | null }).at;

describe('a report by FileId', () => {
  it('records what was downloaded', async () => {
    const { status, body } = await report('binance', { downloaded: [idOf('a.zip')] });

    expect(status).toBe(200);
    expect(body).toEqual({ recorded: 1, withdrawn: 0, corrected: 0, unknown: 0 });
    expect(downloadedAt('a.zip')).not.toBeNull();
    expect(downloadedAt('b.zip')).toBeNull();
  });

  it('counts an id that names nothing as unknown', async () => {
    const { body } = await report('binance', { downloaded: [999_999, -1, 'a.zip'] });

    expect(body).toMatchObject({ recorded: 0, unknown: 3 });
  });

  /** An id is a rowid across every venue, so the venue in the path is what keeps a report to its own files. */
  it('leaves another venue\'s file alone', async () => {
    const { body } = await report('binance', { downloaded: [idOf('g.zip')] });

    expect(body).toMatchObject({ recorded: 0, unknown: 1 });
    expect(downloadedAt('g.zip')).toBeNull();
  });

  it('answers 404 for a venue it does not have', async () => {
    expect((await report('nowhere', { downloaded: [1] })).status).toBe(404);
  });

  it('refuses more files than one report may name', async () => {
    const { status } = await report('binance', { downloaded: Array.from({ length: 10_001 }, (_, n) => n + 1) });

    expect(status).toBe(400);
  });

  /** The parser's own refusal reaches the caller as it is, never as a fault of this service. */
  it('answers a body over the parser\'s limit with 413, not 500', async () => {
    const { status } = await report('binance', { downloaded: Array.from({ length: 30_000 }, (_, n) => 1_000_000 + n) });

    expect(status).toBe(413);
  });
});
