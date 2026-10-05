import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WITHDRAWALS_LOG, putFiles, putVenue, recordSeries } from '../src/catalog';
import { adaptersForVenue } from '../src/venues';
import { openCatalog } from '../src/database';
import { mount } from '../src/api';
import type { Application } from 'express';
import type { Adapter, CatalogFile, Confirmation, Surveys, Verdict } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * A report names files by id, the file's rowid — the catalog resolves the keys a
 * downloader reports by and forwards these. An id that names no confirmed file
 * is counted as unknown rather than written.
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
  vi.restoreAllMocks();

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const report = async (body: unknown) => {
  const server = app.listen(0);
  const port   = (server.address() as { port: number }).port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/reports`, {
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
    const { status, body } = await report({ downloaded: [idOf('a.zip')] });

    expect(status).toBe(200);
    expect(body).toEqual({ recorded: 1, withdrawn: 0, corrected: 0, unknown: 0 });
    expect(downloadedAt('a.zip')).not.toBeNull();
    expect(downloadedAt('b.zip')).toBeNull();
  });

  it('counts an id that names nothing as unknown', async () => {
    const { body } = await report({ downloaded: [999_999, -1, 'a.zip'] });

    expect(body).toMatchObject({ recorded: 0, unknown: 3 });
  });

  /** An id is a rowid across every venue, so one report can settle files of several. */
  it('settles files of any venue in one report', async () => {
    const { body } = await report({ downloaded: [idOf('a.zip'), idOf('g.zip')] });

    expect(body).toMatchObject({ recorded: 2, unknown: 0 });
    expect(downloadedAt('g.zip')).not.toBeNull();
  });

  it('refuses more files than one report may name', async () => {
    const { status } = await report({ downloaded: Array.from({ length: 10_001 }, (_, n) => n + 1) });

    expect(status).toBe(400);
  });

  /** The parser's own refusal reaches the caller as it is, never as a fault of this service. */
  it('answers a body over the parser\'s limit with 413, not 500', async () => {
    const { status } = await report({ downloaded: Array.from({ length: 30_000 }, (_, n) => 1_000_000 + n) });

    expect(status).toBe(413);
  });
});

/**
 * A file that would not download is asked of the venue, and only the venue
 * saying it has gone withdraws it — never a question that went unanswered.
 */
describe('a file reported as undownloadable', () => {
  const binance = (): Adapter => adaptersForVenue('binance').find(one => ! one.host)!;

  /** What the venue answers when asked about the file. */
  const venueSays = (answer: Confirmation | Error): void => {
    vi.spyOn(binance(), 'getContext').mockResolvedValue({} as never);
    vi.spyOn(binance().scanner, 'confirm').mockImplementation(async () => {
      if (answer instanceof Error) throw answer;

      return answer;
    });
  };

  const rules = (rule: (status: number) => Verdict): void => {
    binance().ruleOnFailure = (_row, status) => rule(status);
  };

  afterEach(() => { delete binance().ruleOnFailure; });

  const existence = (path: string): string =>
    (db.prepare('SELECT existence FROM file WHERE path = ?').get(path) as { existence: string }).existence;

  const logged = (): Record<string, unknown>[] =>
    (existsSync(join(dir, WITHDRAWALS_LOG)) ? readFileSync(join(dir, WITHDRAWALS_LOG), 'utf8') : '')
      .split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);

  const failed = async (): Promise<Record<string, unknown>> =>
    (await report({ failed: [idOf('a.zip')] })).body;

  const answered = (status: number): Confirmation => ({ status, headers: new Headers() });

  it('stays owed where the venue still serves it', async () => {
    venueSays({ key: 'a.zip', size: 10, etag: 'e', modified: null });

    expect(await failed()).toMatchObject({ withdrawn: 0 });
    expect(existence('a.zip')).toBe('confirmed');
    expect(logged()).toEqual([]);
  });

  it('is withdrawn where a listing answers without it, and the log says so', async () => {
    venueSays('absent');

    expect(await failed()).toMatchObject({ withdrawn: 1 });
    expect(existence('a.zip')).toBe('absent');
    expect(logged()).toEqual([expect.objectContaining({
      event: 'withdrawn', cause: 'report', venue: 'binance', host: '', path: 'a.zip',
      date: '20250301', size: 10, etag: 'e', downloaded: false,
    })]);
  });

  /** A question that went unanswered is not an answer. */
  it('is left alone where the venue could not be asked', async () => {
    venueSays(new Error('timeout'));

    expect(await failed()).toMatchObject({ withdrawn: 0 });
    expect(existence('a.zip')).toBe('confirmed');

    venueSays(null);

    expect(await failed()).toMatchObject({ withdrawn: 0 });
    expect(logged()).toEqual([]);
  });

  it('is withdrawn on a 404, and left alone on any other status, where the adapter has no rule', async () => {
    for (const status of [403, 429, 500, 502, 503]) {
      venueSays(answered(status));

      expect(await failed()).toMatchObject({ withdrawn: 0 });
    }

    venueSays(answered(404));

    expect(await failed()).toMatchObject({ withdrawn: 1 });
    expect(logged()).toEqual([expect.objectContaining({ cause: 'report', status: 404 })]);
  });

  /** The adapter knows how its venue spells absence, and how it does not. */
  it('is ruled on by the adapter where it has a rule', async () => {
    rules(status => (status === 404 ? 'keep' : null));
    venueSays(answered(404));

    expect(await failed()).toMatchObject({ withdrawn: 0 });

    rules(status => (status === 502 ? 'drop' : null));
    venueSays(answered(502));

    expect(await failed()).toMatchObject({ withdrawn: 1 });
    expect(logged()).toEqual([expect.objectContaining({ status: 502 })]);
  });

  it('falls back to a 404 where the adapter\'s rule declines', async () => {
    rules(() => null);
    venueSays(answered(503));

    expect(await failed()).toMatchObject({ withdrawn: 0 });

    venueSays(answered(404));

    expect(await failed()).toMatchObject({ withdrawn: 1 });
  });
});
