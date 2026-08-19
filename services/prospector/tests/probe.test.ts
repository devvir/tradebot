import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countUnsettled, putFiles, putVenue, recordSeries, unsettled } from '../src/catalog';
import { openCatalog } from '../src/database';
import { surveying, surveyingAs } from '../src/context';
import { blocked, fetchHead } from '../src/http';
import { CONFIRMATIONS, probeFiles, _test_settlement, _test_url } from '../src/probe';
import { html } from '../src/scanners/html';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter, Pacing } from '../src/types';

vi.mock('../src/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/http')>()),
  fetchHead: vi.fn(),
}));

/**
 * A venue whose listings carry no metadata — the shape a probe exists for —
 * declared here rather than borrowed from a real one.
 *
 * **Probing is a venue's property, not this code's.** Which venues need it
 * changes: bybit did while it was surveyed through its CDN's HTML indexes, and
 * stopped the moment its bucket turned out to answer a listing API. A fixture
 * keeps these tests about the mechanism rather than about that choice.
 */
const indexed: Adapter = {
  name:    'indexed',
  scanner: html,
  list:    'https://indexes.example',
  base:    'https://indexes.example',
  root:    '',
  probes:  true,
  dateOf:  (path) => /(\d{4})-(\d{2})-(\d{2})/.exec(path)?.slice(1).join('') ?? null,
};

/** Fast enough not to slow the suite, and the shape a caller really passes. */
const pacing: Pacing = {
  perSecond: 1000, concurrency: 4, ceilingMs: 40, standDownMs: 20, giveUpAfter: 50, batch: 500,
};

let dir: string;
let db:  DatabaseSync;
let venueId: number;

beforeEach(async () => {
  dir     = mkdtempSync(join(tmpdir(), 'probe-'));
  db      = openCatalog(join(dir, 'catalog.db'), { seedData: false });
  venueId = putVenue(db, indexed.name, indexed.base, indexed.root);
});

afterEach(async () => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.mocked(fetchHead).mockReset();
});

/**
 * A series for the venue to hang files on. These tests are about `file` and
 * `wip`, not about series, so one stands in for all of them.
 */
const seriesOn = (venueId: number): number =>
  recordSeries(db, venueId, {
    market: 'perp', dataset: 'klines', symbol: 'BTCUSDT',
    pattern: 'p/{YYYY}{MM}/{SYMBOL}.zip',
  }).id!;

/** A file as a walk of an index leaves it: a path and a date, and nothing else. */
const walked = async (path: string, date: string) =>
  putFiles(db, [{
    venueId, path, date, size: null, etag: null, modified: null,
    existence: 'confirmed', seenAt: '2026-08-08T10:00:00.000Z',
    seriesId: seriesOn(venueId),
  }]);

const answers = (status: number, headers: Record<string, string> = {}) =>
  ({ status, headers: new Headers(headers) });

const found = (etag = 'abc', size = '1024') =>
  answers(200, { etag: `"${etag}"`, 'content-length': size, 'last-modified': 'Tue, 28 Jul 2020 01:45:29 GMT' });

/** The work a probe is given: rows, and how many are left for the log. */
const source = () => ({
  next:      (after: { date: string; path: string } | null, limit: number) =>
    unsettled(db, venueId, after, limit),
  remaining: () => countUnsettled(db, venueId),
});

describe('what a probe writes back', () => {
  it('settles the metadata an index could not carry', async () => {
    await walked('trading/BTCUSDT/BTCUSDT2020-03-25.csv.gz', '20200325');
    vi.mocked(fetchHead).mockResolvedValue(found());

    const summary = await probeFiles(db, indexed, source(), pacing);

    expect(summary).toMatchObject({ settled: 1, missing: 0, refused: 0, failed: 0 });
    expect(db.prepare('SELECT size, etag, modified FROM file').get()).toEqual({
      size: 1024, etag: 'abc', modified: '2020-07-28T01:45:29.000Z',
    });
  });

  /**
   * Learning a file's size for the first time is not the file changing. Without
   * that distinction every probed file would land in the trail on its first
   * sighting, and "what changed since I last looked" would answer "everything".
   */
  it('does not call a first settling a revision', async () => {
    await walked('trading/A/A2020-03-25.csv.gz', '20200325');
    vi.mocked(fetchHead).mockResolvedValue(found());

    await probeFiles(db, indexed, source(), pacing);

    expect(db.prepare('SELECT count(*) n FROM revision').get()).toMatchObject({ n: 0 });
  });

  it('promotes a settled file out of its own queue', async () => {
    await walked('trading/A/A2020-03-25.csv.gz', '20200325');
    vi.mocked(fetchHead).mockResolvedValue(found('first', '10'));

    await probeFiles(db, indexed, source(), pacing);

    // It arrived, so it is catalogued and the probe will not see it again.
    expect(db.prepare('SELECT count(*) n FROM wip').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT size, etag FROM file').get())
      .toMatchObject({ size: 10, etag: 'first' });

    /**
     * Arriving is first discovery, not a revision — otherwise every file a
     * probe ever touched would land in the trail on its way in, and "what
     * changed since I last looked" would answer "everything, once".
     */
    expect(db.prepare('SELECT count(*) n FROM revision').get()).toMatchObject({ n: 0 });
  });

  it('asks the venue at the URL the catalog reconstructs', async () => {
    await walked('trading/BTCUSDT/BTCUSDT2020-03-25.csv.gz', '20200325');
    vi.mocked(fetchHead).mockResolvedValue(found());

    await probeFiles(db, indexed, source(), pacing);

    expect(vi.mocked(fetchHead).mock.calls[0]![1])
      .toBe('https://indexes.example/trading/BTCUSDT/BTCUSDT2020-03-25.csv.gz');
  });
});

/**
 * **Whoever produced the work chose the order.** A walk offers a venue's keys in
 * the venue's order and generation emits a series ascending by date; the probe
 * takes them as they were parked and imposes nothing of its own.
 *
 * Not by date, which is what this used to do. Generating and probing run at the
 * same time, so a cursor over dates leaves every row parked behind it invisible
 * until the next round — however old that row is. Insertion order has no behind.
 */
describe('the order work is taken in', () => {
  it('settles files in the order they were parked', async () => {
    await walked('trading/C/C2026-01-01.csv.gz', '20260101');
    await walked('trading/A/A2020-03-25.csv.gz', '20200325');
    await walked('trading/B/B2023-06-01.csv.gz', '20230601');

    vi.mocked(fetchHead).mockResolvedValue(found());

    await probeFiles(db, indexed, source(), { ...pacing, concurrency: 1 });

    expect(vi.mocked(fetchHead).mock.calls.map(call => call[1].split('/').pop())).toEqual([
      'C2026-01-01.csv.gz', 'A2020-03-25.csv.gz', 'B2023-06-01.csv.gz',
    ]);
  });

  /**
   * The reason for all of it: a key parked mid-pass is asked in that pass, not
   * the next one, even though its date is older than everything already probed.
   */
  it('asks about a key parked behind where it has already reached', async () => {
    await walked('trading/C/C2026-01-01.csv.gz', '20260101');

    vi.mocked(fetchHead).mockImplementation(async () => {
      await walked('trading/A/A2020-03-25.csv.gz', '20200325');

      return found();
    });

    await probeFiles(db, indexed, source(), { ...pacing, concurrency: 1 });

    expect(vi.mocked(fetchHead).mock.calls.map(call => call[1].split('/').pop()))
      .toContain('A2020-03-25.csv.gz');
  });
});

describe('a file the venue does not serve', () => {
  beforeEach(async () => walked('trading/DOTUSD/DOTUSDT2021-12-06.csv.gz', '20211206'));

  /**
   * **One 404 is a moment, not an answer.** A key probed the instant before it
   * was published answers truthfully and is wrong about the archive, so the row
   * stays and the count goes up.
   */
  it('keeps a missing key on the list until the venue has repeated itself', async () => {
    vi.mocked(fetchHead).mockResolvedValue(answers(404));

    const summary = await probeFiles(db, indexed, source(), pacing);

    expect(summary).toMatchObject({ settled: 0, missing: 1, dropped: 0 });
    expect(countUnsettled(db, venueId)).toBe(1);
    expect(db.prepare('SELECT tries FROM wip').get()).toMatchObject({ tries: 1 });
  });

  /**
   * **And nothing written down when it does go.** "Not there" is not a claim
   * about what was ever published, so no row is recorded as absent — the next
   * update generates the key again, and reconciliation is what eventually
   * retires the period.
   */
  it('sets a missing key down without recording anything about it', async () => {
    vi.mocked(fetchHead).mockResolvedValue(answers(404));

    for (let pass = 1; pass < CONFIRMATIONS.confirmed; pass++) await probeFiles(db, indexed, source(), pacing);

    const summary = await probeFiles(db, indexed, source(), pacing);

    expect(summary).toMatchObject({ settled: 0, missing: 1, dropped: 1 });
    expect(countUnsettled(db, venueId)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM file').get()).toMatchObject({ n: 0 });
  });

  /**
   * **A guess is written off quickly; a promise is not.**
   *
   * The budget comes from the row rather than from the pass, which is what lets
   * an update drain a walk's backlog without judging its keys as guesses. Both
   * rows below are probed by the same pass and answered the same way.
   */
  it('spends fewer attempts on a key nothing promised', async () => {
    await putFiles(db, [{
      venueId, path: 'trading/G/G2020-03-25.csv.gz', date: '20200325',
      size: null, etag: null, modified: null, existence: 'assumed',
      seenAt: '2026-08-08T10:00:00.000Z', seriesId: seriesOn(venueId),
    }]);

    vi.mocked(fetchHead).mockResolvedValue(answers(404));

    for (let pass = 0; pass < CONFIRMATIONS.assumed; pass++)
      await probeFiles(db, indexed, source(), pacing);

    const left = unsettled(db, venueId, null, 10).map(row => row.path);

    expect(left).not.toContain('trading/G/G2020-03-25.csv.gz');
    expect(left).toContain('trading/DOTUSD/DOTUSDT2021-12-06.csv.gz');
  });

  /**
   * The cursor moves past what did not settle, so one stubborn file cannot hold
   * the rest of the archive behind it — the next pass offers it again.
   */
  it('does not hand the same row back for ever', async () => {
    await walked('trading/A/A2022-01-01.csv.gz', '20220101');

    vi.mocked(fetchHead).mockImplementation(async (_adapter: Adapter, url: string) =>
      url.includes('DOTUSDT') ? answers(404) : found());

    const summary = await probeFiles(db, indexed, source(), pacing);

    expect(summary).toMatchObject({ settled: 1, missing: 1 });
  });
});

describe('when a probe cannot be answered', () => {
  it('counts a refusal and leaves the row for the next pass', async () => {
    await walked('trading/A/A2020-03-25.csv.gz', '20200325');
    vi.mocked(fetchHead).mockResolvedValue(answers(403));

    const summary = await probeFiles(db, indexed, source(), pacing);

    expect(summary).toMatchObject({ refused: 1, settled: 0 });
    expect(unsettled(db, venueId, null, 10)).toHaveLength(1);
  });

  it('counts a spent retry ladder without abandoning the pass', async () => {
    await walked('trading/A/A2020-03-25.csv.gz', '20200325');
    await walked('trading/B/B2021-03-25.csv.gz', '20210325');

    vi.mocked(fetchHead).mockImplementation(async (_adapter: Adapter, url: string) => {
      if (url.includes('/A/')) throw new Error('Probe failed: timeout');

      return found();
    });

    const summary = await probeFiles(db, indexed, source(), pacing);

    expect(summary).toMatchObject({ failed: 1, settled: 1 });
  });
});

describe('reading a HEAD', () => {
  const row = { venueId: 1, path: 'a/b.csv.gz', date: '20200325' };

  it('takes size, checksum and last-modified as the catalog stores them', () => {
    const settled = _test_settlement(row, new Headers({
      'content-length': '121118',
      etag:             '"2bcba5ed0de8182dc4114f5c57f7e07b"',
      'last-modified':  'Tue, 28 Jul 2020 01:45:29 GMT',
    }));

    expect(settled).toMatchObject({
      size: 121118, etag: '2bcba5ed0de8182dc4114f5c57f7e07b', modified: '2020-07-28T01:45:29.000Z',
    });
  });

  /** A CDN adds `-gzip` when it re-encodes; S3 adds `-<n>` for a multipart upload. */
  it('strips what a CDN added and keeps what S3 meant', () => {
    expect(_test_settlement(row, new Headers({ etag: '"abc-gzip"' })).etag).toBe('abc');
    expect(_test_settlement(row, new Headers({ etag: '"abc-5"' })).etag).toBe('abc-5');
  });

  it('reports what a header did not say as unknown rather than zero', () => {
    const settled = _test_settlement(row, new Headers({}));

    expect(settled).toMatchObject({ size: null, etag: null, modified: null });
  });

  it('rebuilds a URL from base, root and path', () => {
    expect(_test_url({ ...indexed, root: 'data/' }, row)).toBe('https://indexes.example/data/a/b.csv.gz');
  });
});

/**
 * A 403 means two very different things, and getting them the wrong way round is
 * expensive in one direction only: mistaking a key's refusal for a block costs a
 * paused pass, mistaking a block for a key's refusal costs the address.
 */
describe('telling a block from a key refusal', () => {
  it('reads a CloudFront error page as a block', () => {
    expect(blocked(indexed, 403, new Headers({ server: 'CloudFront', 'x-cache': 'Error from cloudfront' })))
      .toBe(true);
  });

  it('reads an S3 answer about one key as a key refusal', () => {
    expect(blocked(indexed, 403, new Headers({ server: 'AmazonS3', 'x-amz-error-code': 'AccessDenied' })))
      .toBe(false);
  });

  it('treats being asked to slow down as aimed at us', () => {
    expect(blocked(indexed, 429, new Headers({}))).toBe(true);
  });

  /**
   * **A bucket that will not admit what it does not have.** bitget's S3 grants
   * `GetObject` and not `ListBucket`, so a key it never held answers exactly as a
   * refusal does. Read by the rule above, its first missing file would stand the
   * venue down for good — so the venue overrules it.
   */
  it('lets a venue overrule the guess for its own archive', () => {
    const hidden: Adapter = {
      ...indexed,
      refusesUs: (_status, headers) => headers.get('server') !== 'AmazonS3',
    };

    const missing = new Headers({ server: 'AmazonS3', 'content-type': 'application/xml' });

    expect(blocked(indexed, 403, missing)).toBe(true);
    expect(blocked(hidden,  403, missing)).toBe(false);
    expect(blocked(hidden,  403, new Headers({ server: 'CloudFront' }))).toBe(true);
  });
});

describe('when a venue refuses us rather than a key', () => {
  beforeEach(async () => {
    for (let day = 1; day <= 40; day++)
      await walked(`trading/A/A2021-01-${String(day).padStart(2, '0')}.csv.gz`,
        `202101${String(day).padStart(2, '0')}`);
  });

  /**
   * A ban lapses only while nothing is asking, so slowing down is not a remedy —
   * every further request is one that may extend it.
   */
  it('stops the pass at once rather than pausing through it', async () => {
    vi.mocked(fetchHead).mockResolvedValue(
      answers(403, { server: 'CloudFront', 'x-cache': 'Error from cloudfront' }));

    const summary = await probeFiles(db, indexed, source(), pacing);

    expect(summary.requests).toBeLessThan(10);
    expect(summary.settled).toBe(0);
  });

  /** Where a venue refuses single keys, the pass carries on through them. */
  it('carries on past a key it may not read', async () => {
    vi.mocked(fetchHead).mockImplementation(async (_adapter: Adapter, url: string) =>
      url.includes('A2021-01-01')
        ? answers(403, { server: 'AmazonS3', 'x-amz-error-code': 'AccessDenied' })
        : found());

    const summary = await probeFiles(db, indexed, source(), pacing);

    expect(summary).toMatchObject({ refused: 1, settled: 39 });
  });

  /**
   * The counts alone cannot separate a pass that finished from one that was
   * blocked after settling rows, and the caller waits fifteen minutes or ten
   * depending on which it was.
   */
  it('says it was abandoned rather than leaving it to be inferred', async () => {
    vi.mocked(fetchHead).mockImplementation(async (_adapter: Adapter, url: string) =>
      url.includes('A2021-01-01')
        ? found()
        : answers(403, { server: 'CloudFront', 'x-cache': 'Error from cloudfront' }));

    const summary = await probeFiles(db, indexed, source(), pacing);

    expect(summary.settled).toBeGreaterThan(0);
    expect(summary.abandoned).toBe(true);
  });
});

/**
 * **A pass is the wrong unit to read a pause on.** It ends when the backlog does,
 * which on a venue whose keys are constructed is days — so a stop read once per
 * pass is a stop nobody lives to see. It is read where the loop actually has a
 * boundary: every time it loads a batch.
 */
describe('stopping a pass because somebody asked', () => {
  /** One row per batch, so the flag is read between two rows rather than after all of them. */
  const oneAtATime: Pacing = { ...pacing, batch: 1, concurrency: 1 };

  const three = async () => {
    for (const day of ['2020-03-25', '2020-03-26', '2020-03-27'])
      await walked(`trading/A/A${day}.csv.gz`, day.replaceAll('-', ''));
  };

  it('stops at the next batch, and says so', async () => {
    await three();
    vi.mocked(fetchHead).mockResolvedValue(found());

    /** Asked for after the first batch is in hand, which is the case that was broken. */
    let asked = false;

    const summary = await probeFiles(db, indexed, source(), oneAtATime, () => {
      const now = asked;

      asked = true;

      return now;
    });

    expect(summary.stopped).toBe(true);
    expect(summary.settled).toBe(1);

    /** The rest are owed, not lost: starting the venue again offers them straight back. */
    expect(db.prepare('SELECT count(*) n FROM wip').get()).toMatchObject({ n: 2 });
  });

  it('asks the venue nothing when the pause is already in force', async () => {
    await three();
    vi.mocked(fetchHead).mockResolvedValue(found());

    const summary = await probeFiles(db, indexed, source(), oneAtATime, () => true);

    expect(summary).toMatchObject({ stopped: true, settled: 0, requests: 0 });
    expect(vi.mocked(fetchHead)).not.toHaveBeenCalled();
  });

  /**
   * Separate from `abandoned`, which is the venue's doing and resumes on its own.
   * A pass that simply ran out of work is neither.
   */
  it('does not call an ordinary finish a stop', async () => {
    await three();
    vi.mocked(fetchHead).mockResolvedValue(found());

    const summary = await probeFiles(db, indexed, source(), oneAtATime);

    expect(summary).toMatchObject({ stopped: false, abandoned: false, settled: 3 });
  });
});

/**
 * A venue whose bucket says "absent" with a `403`.
 *
 * **This is bitget, and it is the ordinary case rather than an edge.** Its S3
 * grants `GetObject` and not `ListBucket`, so a key it does not have answers
 * `403 AccessDenied` — the same status as being turned away, separable only by
 * the headers. A probe exists to ask about keys that may not be there and meets
 * runs of them at every series' trailing edge, so reading those as refusals
 * stood the venue down after fifty perfectly ordinary gaps and reported it as
 * the venue refusing us.
 */
describe('a venue that spells absence as 403', () => {
  const absent403: Adapter = {
    ...indexed,
    refusesUs:     (_status, headers) => headers.get('server') !== 'AmazonS3',
    ruleOnFailure: (status, headers) =>
      (status === 403 && headers.get('server') === 'AmazonS3' ? 'drop' : null),
  };

  const s3Absent = () => answers(403, { server: 'AmazonS3', 'x-amz-error-code': 'AccessDenied' });

  beforeEach(async () => {
    for (let day = 1; day <= 60; day++)
      await walked(`trading/A/A2021-01-${String(day).padStart(2, '0')}.csv.gz`,
        `202101${String(day).padStart(2, '0')}`);
  });

  /**
   * Sixty absent keys and nothing settled — which at `giveUpAfter: 50` is
   * precisely the shape that used to abandon the pass.
   */
  it('counts a ruled absence as missing rather than as a refusal', async () => {
    vi.mocked(fetchHead).mockResolvedValue(s3Absent());

    const summary = await probeFiles(db, absent403, source(), pacing);

    expect(summary.refused).toBe(0);
    expect(summary.missing).toBe(60);
  });

  it('works the whole batch instead of standing the venue down', async () => {
    vi.mocked(fetchHead).mockResolvedValue(s3Absent());

    const summary = await probeFiles(db, absent403, source(), pacing);

    expect(summary.abandoned).toBeFalsy();
    expect(summary.requests).toBe(60);
  });

  /**
   * **A ruled absence is final at once.** The core asks again because a `404` a
   * moment before publication is truthful and wrong; an adapter answering
   * `'drop'` is saying it knows better for its venue — bitget's bucket has no
   * other meaning for that `403` — so asking twice more only spends requests.
   */
  it('drops the key on the first ruled absence', async () => {
    vi.mocked(fetchHead).mockResolvedValue(s3Absent());

    await probeFiles(db, absent403, source(), pacing);

    expect(countUnsettled(db, venueId)).toBe(0);
  });

  /**
   * **The distinction the headers carry has to survive all of this.** A refusal
   * aimed at us still ends the pass at once, however many absences preceded it.
   */
  it('still stops at once when the venue really is refusing us', async () => {
    vi.mocked(fetchHead).mockResolvedValue(
      answers(403, { server: 'CloudFront', 'x-cache': 'Error from cloudfront' }));

    const summary = await probeFiles(db, absent403, source(), pacing);

    expect(summary.abandoned).toBe(true);
    expect(summary.requests).toBeLessThan(10);
  });
});

/**
 * Giving up on a key nobody is going to settle.
 *
 * **A miss means different things at different venues**, and only the venue
 * knows which. A key read out of a listing that answers 404 is a surprise worth
 * asking about again; a key this service constructed that answers 404 is usually
 * just right. So the orchestrator counts attempts, applies a blunt cap, and lets
 * an adapter overrule it in either direction.
 */
/**
 * **A pattern and a date cannot express a period cut into an unknown number of
 * pieces.** bitget splits a day's trades every hundred thousand rows and nothing
 * in the path says how many parts there are — the only way to learn is that the
 * next one is not there. So the venue is asked as each part arrives.
 */
describe('when an answer implies another key', () => {
  const parts: Adapter = {
    ...indexed,
    ruleOnSuccess: (row) => ({
      action: 'accept',
      next:   row.path.replace(/_001\./, '_002.'),
    }),
  };

  /**
   * **The chain drains inside the pass that started it.** A parked part sorts
   * after the one that implied it, so the cursor picks it up on the next batch
   * rather than a day later — which is what makes a hundred-part day one pass
   * and not a hundred.
   */
  it('parks what the venue implied, and follows it to the end', async () => {
    await walked('trading/A/A2020-03-25_001.csv.gz', '20200325');

    vi.mocked(fetchHead).mockImplementation(async (_adapter, url) =>
      (url.includes('_001') ? found() : answers(404)));

    const summary = await probeFiles(db, parts, source(), pacing);

    expect(summary).toMatchObject({ settled: 1, implied: 1, missing: 1 });
    expect(db.prepare('SELECT path FROM file').all())
      .toEqual([{ path: 'trading/A/A2020-03-25_001.csv.gz' }]);

    // The part that is not there takes its confirmations like any other absence.
    for (let pass = 1; pass < CONFIRMATIONS.confirmed; pass++) await probeFiles(db, parts, source(), pacing);

    expect(countUnsettled(db, venueId)).toBe(0);
  });

  /**
   * **The chain ends where the archive does.** A part that is not there is an
   * ordinary 404: the key leaves the list, nothing is written down, and nothing
   * further is implied.
   */
  it('stops the chain at the first part that is not there', async () => {
    await walked('trading/A/A2020-03-25_001.csv.gz', '20200325');
    vi.mocked(fetchHead).mockResolvedValue(answers(404));

    for (let pass = 1; pass < CONFIRMATIONS.confirmed; pass++) await probeFiles(db, parts, source(), pacing);

    const summary = await probeFiles(db, parts, source(), pacing);

    expect(summary).toMatchObject({ settled: 0, implied: 0, dropped: 1 });
    expect(countUnsettled(db, venueId)).toBe(0);
  });

  /**
   * **A published key that is not the file.** An archive whose key names a
   * manifest has it discarded rather than catalogued, and what it named takes
   * its place.
   */
  it('discards a key the venue says is not the file', async () => {
    const manifest: Adapter = {
      ...indexed,
      ruleOnSuccess: (row) => (row.path.endsWith('.json')
        ? { action: 'replace', next: row.path.replace('.json', '.csv.gz') }
        : null),
    };

    await walked('trading/A/A2020-03-25.json', '20200325');
    vi.mocked(fetchHead).mockResolvedValue(found());

    const summary = await probeFiles(db, manifest, source(), pacing);

    /**
     * **And the replacement is asked about in the same pass**, because it was
     * parked ahead of the cursor rather than at a date the sweep had passed. The
     * manifest itself never becomes a file; what it named does.
     */
    expect(summary).toMatchObject({ settled: 1, implied: 1, dropped: 1 });
    expect(db.prepare('SELECT path FROM file').all())
      .toEqual([{ path: 'trading/A/A2020-03-25.csv.gz' }]);
    expect(db.prepare('SELECT path FROM wip').all()).toEqual([]);
  });
});

describe('when a probe keeps missing', () => {
  const missing = () => answers(404);

  /**
   * **A 404 ends the attempt, a refusal does not.** The first is the venue
   * answering about the key; the second is the venue answering about us, and it
   * says nothing whatever about whether the file is there.
   */
  it('counts an attempt against a row that was refused rather than missing', async () => {
    await walked('trading/A/A2020-03-25.csv.gz', '20200325');
    vi.mocked(fetchHead).mockResolvedValue(answers(500));

    const summary = await probeFiles(db, indexed, source(), pacing);

    expect(summary).toMatchObject({ refused: 1, dropped: 0 });
    expect(db.prepare('SELECT tries FROM wip').get()).toMatchObject({ tries: 1 });
    expect(countUnsettled(db, venueId)).toBe(1);
  });

  it('keeps offering a refused row across passes, counting each one', async () => {
    await walked('trading/A/A2020-03-25.csv.gz', '20200325');
    vi.mocked(fetchHead).mockResolvedValue(answers(500));

    for (let pass = 0; pass < 3; pass++) await probeFiles(db, indexed, source(), pacing);

    expect(db.prepare('SELECT tries FROM wip').get()).toMatchObject({ tries: 3 });
  });

  /**
   * "Drop it now" — the adapter has decided, whatever the count says. Deleted
   * rather than marked absent: these rows were never claims about what a venue
   * published, so recording a withdrawal would put a fiction where a
   * measurement belongs.
   */
  it('drops a row the adapter rules absent, without asking again', async () => {
    const decisive: Adapter = { ...indexed, ruleOnFailure: () => 'drop' };

    await walked('trading/A/A2020-03-25.csv.gz', '20200325');
    vi.mocked(fetchHead).mockResolvedValue(missing());

    const summary = await probeFiles(db, decisive, source(), pacing);

    expect(summary).toMatchObject({ missing: 1, dropped: 1 });
    expect(countUnsettled(db, venueId)).toBe(0);
  });

  /** "Don't drop it" — no cap applies, however many times it has been asked. */
  it('never drops a row the adapter says to keep', async () => {
    const patient: Adapter = { ...indexed, ruleOnFailure: () => 'keep' };

    await walked('trading/A/A2020-03-25.csv.gz', '20200325');
    db.prepare('UPDATE wip SET tries = 9999').run();
    vi.mocked(fetchHead).mockResolvedValue(missing());

    const summary = await probeFiles(db, patient, source(), pacing);

    expect(summary).toMatchObject({ dropped: 0 });
    expect(countUnsettled(db, venueId)).toBe(1);
  });

  /**
   * **A refusal has no count to run down.** It says nothing about the file, so
   * there is nothing to conclude however often it arrives: the row stays, the
   * pass does not finish, and a venue answering nonsense stays visible instead
   * of being quietly worked around.
   */
  it('never sets down a row the venue keeps refusing', async () => {
    await walked('trading/A/A2020-03-25.csv.gz', '20200325');
    db.prepare('UPDATE wip SET tries = 999').run();
    vi.mocked(fetchHead).mockResolvedValue(answers(503));

    const summary = await probeFiles(db, indexed, source(), pacing);

    expect(summary).toMatchObject({ dropped: 0 });
    expect(countUnsettled(db, venueId)).toBe(1);
  });

  /**
   * A refusal is about us, not about the key. okx's is a sticky CloudFront 403
   * that arrives for paths which certainly exist, so counting it against them
   * would delete a venue's candidates during one bad spell.
   */
  it('lets an adapter spare a row that was refused rather than missing', async () => {
    const careful: Adapter = {
      ...indexed,
      ruleOnFailure: (status, _headers, tries) =>
        (status === 404 ? (tries >= 3 ? 'drop' : null) : 'keep'),
    };

    await walked('trading/A/A2020-03-25.csv.gz', '20200325');
    db.prepare('UPDATE wip SET tries = 99').run();
    vi.mocked(fetchHead).mockResolvedValue(answers(403, { server: 'AmazonS3' }));

    const summary = await probeFiles(db, careful, source(), pacing);

    expect(summary).toMatchObject({ dropped: 0 });
    expect(countUnsettled(db, venueId)).toBe(1);
  });
});

/**
 * What a `404` means depends on what put the key on the list.
 *
 * **An index promised the file; a pattern only guessed at it.** The same status
 * through the same hook is a contradiction in one pass and the ordinary answer
 * in the other, and an adapter cannot tell them apart from the arguments it is
 * handed — so it asks the venue.
 */
describe('which pass a rule is being asked in', () => {
  const walked404: Adapter = {
    ...indexed,
    ruleOnFailure: (status, _headers, tries) =>
      (status === 404 && surveying(walked404) === 'walk' && tries < 50 ? 'keep' : null),
  };

  beforeEach(async () => walked404 && walked('trading/A/A2020-03-25.csv.gz', '20200325'));

  it('holds a key an index named, for as long as the walk says to', async () => {
    vi.mocked(fetchHead).mockResolvedValue(answers(404));

    await surveyingAs(walked404, 'walk', async () => {
      for (let pass = 0; pass < CONFIRMATIONS.confirmed + 2; pass++)
        await probeFiles(db, walked404, source(), pacing);
    });

    expect(countUnsettled(db, venueId)).toBe(1);
  });

  it('writes off the same key in an update, where nothing promised it', async () => {
    vi.mocked(fetchHead).mockResolvedValue(answers(404));

    await surveyingAs(walked404, 'update', async () => {
      for (let pass = 0; pass < CONFIRMATIONS.confirmed; pass++)
        await probeFiles(db, walked404, source(), pacing);
    });

    expect(countUnsettled(db, venueId)).toBe(0);
  });

  /** Outside a pass there is no answer, and the core's own rule decides. */
  it('answers nothing when no pass is running', () => {
    expect(surveying(walked404)).toBeNull();
  });
});
