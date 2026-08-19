import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { putVenue, recordSeries, seriesFor } from '../src/catalog';
import { openCatalog } from '../src/database';
import { backfill } from '../src/backfill';
import { fetchHead } from '../src/http';
import { s3 } from '../src/scanners/s3';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter, Found } from '../src/types';

vi.mock('../src/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/http')>()),
  fetchHead: vi.fn(),
}));

/**
 * Earning a tip for a series nobody has read.
 *
 * **A tip is a claim, and a new series has not earned one.** "Everything below
 * `OVERDUE_DAYS` ago is settled" is true of a series we have been generating for
 * and false of one discovered this morning. This is what makes it true: probe
 * the floor, and keep stepping down while the venue keeps answering.
 */
const venue: Adapter = {
  name:    'demo',
  scanner: s3,
  list:    'https://demo.example',
  base:    'https://demo.example',
  root:    '',
  dateOf:  (path) => /(\d{4})(\d{2})(\d{2})/.exec(path)?.slice(1).join('') ?? null,
};

const DAILY   = 'x/{YYYY}{MM}{DD}/{SYMBOL}.zip';
const MONTHLY = 'x/{YYYY}{MM}/{SYMBOL}.zip';

/** The pass covered up to here, so the floor is OVERDUE_DAYS below it. */
const COVERED = new Date('2026-08-01T00:00:00Z');
const FLOOR   = '20260716';

const found = (over: Partial<Found> = {}): Found =>
  ({ market: 'SPOT', dataset: 'trades', symbol: 'BTC-USDT', pattern: DAILY, ...over });

let dir: string;
let db:  DatabaseSync;
let id:  number;

const answers = (status: number) => ({
  status,
  headers: new Headers(status === 200
    ? { 'content-length': '10', etag: '"e"', 'last-modified': 'Tue, 14 Jul 2026 00:00:00 GMT' }
    : {}),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'backfill-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });
  id  = putVenue(db, venue.name, venue.base, venue.root);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.mocked(fetchHead).mockReset();
});

describe('earning a new series its tip', () => {
  /**
   * **The ordinary case, and it costs one request.** An instrument listed since
   * the last pass has nothing below the floor, so the first probe is absent and
   * the tip is the floor — where a flat rule would have put it, with the
   * difference that it was measured.
   */
  /**
   * **A file at the floor is the expected case and reports nothing.** The floor
   * is where probing was always going to start, so warning there would warn on
   * nearly every series the preamble touches; what is worth a line is history
   * *under* it.
   */
  it('says nothing about the floor itself', async () => {
    const row = recordSeries(db, id, found());

    vi.mocked(fetchHead).mockImplementation(async (_adapter, url: string) =>
      answers(url.includes(FLOOR) ? 200 : 404) as never);

    expect(await backfill(db, venue, row, COVERED, '20200101'))
      .toMatchObject({ tip: FLOOR, found: 1, walked: 0 });
  });

  it('stops at the first absence and takes the floor as its tip', async () => {
    const row = recordSeries(db, id, found());

    vi.mocked(fetchHead).mockResolvedValue(answers(404) as never);

    const out = await backfill(db, venue, row, COVERED, '20200101');

    expect(out).toMatchObject({ tip: FLOOR, found: 0, walked: 0 });
    expect(fetchHead).toHaveBeenCalledTimes(1);
  });

  /**
   * **Where it is not ordinary, it is the only thing that recovers the
   * archive.** Generation never looks below a tip, and the unlisted venues have
   * no index to walk, so history under the floor is reachable no other way.
   */
  it('walks down while the venue answers, and catalogues what it finds', async () => {
    const row = recordSeries(db, id, found());

    vi.mocked(fetchHead).mockImplementation(async (_adapter, url: string) =>
      answers(/20260713|20260714|20260715|20260716/.test(url) ? 200 : 404) as never);

    const out = await backfill(db, venue, row, COVERED, '20200101');

    // Three of the four sit below the floor, so one month is reported and the
    // file at the floor itself — the expected case — says nothing.
    expect(out).toMatchObject({ tip: FLOOR, found: 4, walked: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM file').get()).toMatchObject({ n: 4 });

    // A HEAD carries everything a file row holds, so nothing is left to re-ask.
    expect(db.prepare('SELECT size, etag FROM file LIMIT 1').get())
      .toMatchObject({ size: 10, etag: 'e' });
  });

  /**
   * **The tip is the floor either way.** Everything at or below it is settled by
   * the time this returns — the periods walked through by having been recorded,
   * and the one under them by having been answered absent.
   */
  it('does not lower the tip to what it recovered', async () => {
    const row = recordSeries(db, id, found());

    vi.mocked(fetchHead).mockImplementation(async (_adapter, url: string) =>
      answers(url.includes('202607') ? 200 : 404) as never);

    expect((await backfill(db, venue, row, COVERED, '20200101')).tip).toBe(FLOOR);
  });

  /** A monthly series walks months, and its floor is a month. */
  it('walks a monthly series at its own grain', async () => {
    const row = recordSeries(db, id, found({ pattern: MONTHLY, symbol: 'ETH-USDT' }));

    vi.mocked(fetchHead).mockImplementation(async (_adapter, url: string) =>
      answers(/202605|202606/.test(url) ? 200 : 404) as never);

    const out = await backfill(db, venue, row, COVERED, '202001');

    expect(out).toMatchObject({ tip: '202606', found: 2 });
  });

  /**
   * **A bound on being wrong, not on being right.** Nothing is published before
   * a venue's archive begins, so a walk that reaches it has stopped measuring
   * and started running away — which is what a soft `200` looks like.
   */
  it('stops at the venue oldest date rather than walking to the epoch', async () => {
    const row = recordSeries(db, id, found());

    vi.mocked(fetchHead).mockResolvedValue(answers(200) as never);

    const out = await backfill(db, venue, row, COVERED, '20260701');

    expect(out.found).toBeLessThan(30);
    expect(seriesFor(db, id)[0]!.tip).toBeNull();
  });
});
