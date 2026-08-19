import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { advanceRun, ancestorsOf, beginJob, closeRun, establishedAt, exclusionsFor, markDownloaded, markWithdrawn, openJob, openPartitions, putFiles, putVenue, recordSeries, venueIds, settleFiles, unsettled } from '../src/catalog';
import { assertWritable, migrate, openCatalog, SCHEMA_VERSION, version } from '../src/database';
import { _test_BREATH_MS as BREATH_MS } from '../src/catalog/queries';
import type { CatalogFile, Run } from '../src/catalog';
import { DatabaseSync } from 'node:sqlite';

let dir: string;
let db:  DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'catalog-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
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

const file = (path: string, over: Partial<CatalogFile> = {}): CatalogFile => ({
  venueId: 1, path, date: '20250301', size: 10, etag: 'e',
  modified: null, existence: 'confirmed', seenAt: '2026-01-01T00:00:00.000Z',
  seriesId: seriesOn(over.venueId ?? 1), ...over,
});

/** Open a job over these scopes and hand back its partitions, in order. */
const partitionsFor = (venueId: number, scopes: string[]): Run[] => {
  beginJob(db, venueId, 'walk', scopes);

  return openPartitions(db, venueId, 'walk');
};

describe('opening', () => {
  it('creates the schema when the file is new', () => {
    const row = db.prepare(`SELECT count(*) n FROM sqlite_master WHERE type='table'`)
      .get() as { n: number };

    expect(row.n).toBeGreaterThan(0);
  });

  it('opens in WAL, so a reader never blocks the writer', () => {
    expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
  });

  /**
   * SQLite is dynamically typed unless a table says otherwise: a declared
   * INTEGER column will happily hold a string, and the mistake surfaces later as
   * a query that matches nothing.
   */
  it('enforces column types', () => {
    expect(() => db.prepare(
      `INSERT INTO file (venue_id, path, date, size, existence, seen_at, series_id)
            VALUES (1, 'a', 'b', 'not-a-number', 'confirmed', 'now', ?)`)
      .run(seriesOn(1)))
      .toThrow(/INTEGER/);
  });

  /**
   * The probe has to write the main database: opening a read-only file succeeds,
   * and so does asking for WAL on a database already in it, so neither says
   * anything about whether a survey can record what it finds.
   */
  it('proves it can write before anything else runs', () => {
    const at = version(db);

    expect(() => assertWritable(db, join(dir, 'catalog.db'))).not.toThrow();
    expect(version(db)).toBe(at);
  });

  it('refuses a catalog it cannot write', () => {
    chmodSync(join(dir, 'catalog.db'), 0o444);

    const readOnly = openCatalog(join(dir, 'catalog.db'), { seedData: false });

    expect(() => assertWritable(readOnly, join(dir, 'catalog.db'))).toThrow(/read-only mount/);

    readOnly.close();
    chmodSync(join(dir, 'catalog.db'), 0o644);
  });

  /** A present database is never touched — no migration, no repair. */
  it('leaves an existing catalog alone', () => {
    putVenue(db, 'binance', 'https://x', 'data/');
    db.close();

    db = openCatalog(join(dir, 'catalog.db'), { seedData: false });

    expect(db.prepare('SELECT name FROM venue').all()).toEqual([{ name: 'binance' }]);
  });
});

describe('files', () => {
  it('is idempotent, so a re-walk costs nothing but time', async () => {
    putVenue(db, 'binance', 'https://x', 'data/');
    await putFiles(db, [file('spot/a-2025-03.zip')]);
    await putFiles(db, [file('spot/a-2025-03.zip')]);

    expect(db.prepare('SELECT count(*) n FROM file').get()).toMatchObject({ n: 1 });
  });

  it('updates metadata a venue has changed', async () => {
    putVenue(db, 'binance', 'https://x', 'data/');
    await putFiles(db, [file('spot/a-2025-03.zip', { size: 10, etag: 'old' })]);
    await putFiles(db, [file('spot/a-2025-03.zip', { size: 99, etag: 'new' })]);

    expect(db.prepare('SELECT size, etag FROM file').get())
      .toMatchObject({ size: 99, etag: 'new' });
  });

  /** The prefix range is the query the work handout depends on. */
  it('answers a prefix range as an index seek', async () => {
    putVenue(db, 'binance', 'https://x', 'data/');
    await putFiles(db, [
      file('spot/monthly/trades/A-2025-03.zip'),
      file('spot/monthly/klines/A-2025-03.zip'),
      file('futures/um/trades/A-2025-03.zip'),
    ]);

    const rows = db.prepare(
      `SELECT path FROM file
        WHERE venue_id = 1 AND path >= 'spot/monthly/' AND path < 'spot/monthly0'`).all();

    expect(rows).toHaveLength(2);
  });

  it('answers a month as one date range across granularities', async () => {
    putVenue(db, 'binance', 'https://x', 'data/');
    await putFiles(db, [
      file('spot/monthly/A-2025-03.zip', { date: '20250301' }),
      file('spot/daily/A-2025-03-17.zip', { date: '20250317' }),
      file('spot/daily/A-2025-04-01.zip', { date: '20250401' }),
    ]);

    const rows = db.prepare(
      `SELECT path FROM file WHERE venue_id = 1 AND date BETWEEN '20250301' AND '20250331'`).all();

    expect(rows).toHaveLength(2);
  });
});

describe('re-walking', () => {
  const seed = async () => {
    putVenue(db, 'binance', 'https://x', 'data/');
    await putFiles(db, [file('spot/a-2025-03.zip', { seenAt: 'T1', size: 10, etag: 'v1' })]);
  };

  /**
   * First discovery must not drift: it answers "when did we first learn this
   * existed", and a re-walk seeing the same file again does not change that.
   */
  it('keeps seen_at at first discovery', async () => {
    await seed();
    await putFiles(db, [file('spot/a-2025-03.zip', { seenAt: 'T2', size: 10, etag: 'v1' })]);

    expect(db.prepare('SELECT seen_at, last_seen FROM file').get())
      .toMatchObject({ seen_at: 'T1', last_seen: 'T2' });
  });

  it('records nothing in the trail when a file is unchanged', async () => {
    await seed();
    await putFiles(db, [file('spot/a-2025-03.zip', { seenAt: 'T2', size: 10, etag: 'v1' })]);

    expect(db.prepare('SELECT count(*) n FROM revision').get()).toMatchObject({ n: 0 });
  });

  /**
   * "Modified" has no single useful meaning, so the trail is a list of
   * observations and each consumer compares against its own high-water mark.
   */
  /**
   * The trail holds the version being **replaced**, not the one arriving: the
   * arriving one is in `file`, and storing it twice would say nothing about what
   * came before it. `seen_at` is when the change was observed either way.
   */
  it('files the outgoing version in the trail when a version changes', async () => {
    await seed();
    await putFiles(db, [file('spot/a-2025-03.zip', { seenAt: 'T2', size: 99, etag: 'v2' })]);

    expect(db.prepare('SELECT * FROM revision').all())
      .toMatchObject([{ path: 'spot/a-2025-03.zip', seen_at: 'T2', etag: 'v1' }]);
    expect(db.prepare('SELECT size, etag FROM file').get())
      .toMatchObject({ size: 99, etag: 'v2' });
  });

  /**
   * A new version has not been downloaded, whatever was true of the last one —
   * and the version that *was* downloaded says so in the trail, which is what
   * lets a consumer tell "the file I built from has changed" from "this file
   * changed at some point".
   */
  it('sends a changed file back to pending and remembers the version held', async () => {
    await seed();
    markDownloaded(db, [{ venueId: 1, path: 'spot/a-2025-03.zip' }], 'D1');

    expect(db.prepare('SELECT downloaded_at FROM file').get())
      .toMatchObject({ downloaded_at: 'D1' });

    await putFiles(db, [file('spot/a-2025-03.zip', { seenAt: 'T2', size: 99, etag: 'v2' })]);

    expect(db.prepare('SELECT downloaded_at FROM file').get())
      .toMatchObject({ downloaded_at: null });
    expect(db.prepare('SELECT etag, downloaded_at FROM revision').get())
      .toMatchObject({ etag: 'v1', downloaded_at: 'D1' });
  });

  it('answers what changed since a given moment', async () => {
    await seed();
    await putFiles(db, [file('spot/a-2025-03.zip', { seenAt: 'T2', size: 99, etag: 'v2' })]);
    await putFiles(db, [file('spot/a-2025-03.zip', { seenAt: 'T3', size: 50, etag: 'v3' })]);

    expect(db.prepare(`SELECT count(*) n FROM revision WHERE seen_at > 'T2'`).get())
      .toMatchObject({ n: 1 });
  });

  /**
   * A withdrawn file keeps its row, its history and its first-seen date. Nothing
   * is ever removed, so the catalog stays a record of everything ever published.
   */
  it('marks a file the venue stopped offering, without deleting it', async () => {
    await seed();
    await putFiles(db, [file('spot/b-2025-03.zip', { seenAt: 'T2' })]);

    const gone = markWithdrawn(db, 1, 'spot/', 'spot0', 'T2');

    expect(gone).toBe(1);
    expect(db.prepare(`SELECT existence, seen_at FROM file WHERE path LIKE 'spot/a%'`).get())
      .toMatchObject({ existence: 'absent', seen_at: 'T1' });
    expect(db.prepare(`SELECT existence FROM file WHERE path LIKE 'spot/b%'`).get())
      .toMatchObject({ existence: 'confirmed' });
  });

  /** A first pass has nothing older than its own start, so it withdraws nothing. */
  it('withdraws nothing on a first pass', async () => {
    await seed();

    expect(markWithdrawn(db, 1, 'spot/', 'spot0', 'T1')).toBe(0);
  });

  it('leaves other prefixes alone', async () => {
    await seed();
    await putFiles(db, [file('futures/a-2025-03.zip', { seenAt: 'T1' })]);

    markWithdrawn(db, 1, 'spot/', 'spot0', 'T2');

    expect(db.prepare(`SELECT existence FROM file WHERE path LIKE 'futures/%'`).get())
      .toMatchObject({ existence: 'confirmed' });
  });
});

/**
 * A walk on an index venue establishes that a file exists and nothing more, so
 * the metadata is settled afterwards, one HEAD at a time.
 */
describe('settling metadata a listing could not carry', () => {
  const unmeasured = (path: string, date: string): CatalogFile =>
    file(path, { date, size: null, etag: null, modified: null });

  beforeEach(async () => {
    putVenue(db, 'bybit', 'https://public.bybit.com', '');
    await putFiles(db, [
      unmeasured('trading/B/B2023-01-01.csv.gz', '20230101'),
      unmeasured('trading/A/A2020-03-25.csv.gz', '20200325'),
    ]);
  });

  /**
   * **In the order they were parked, which is the order they were produced.**
   * Not by date: generation and probing run at once, so a cursor over dates has
   * rows appearing behind a position it has already passed — invisible until the
   * next round however old they are. Whoever produced the work chose the order,
   * and taking it as given is what makes 'everything before the cursor was
   * asked' true continuously rather than only when a pass drains.
   */
  it('offers unsettled files in the order they were parked', () => {
    expect(unsettled(db, 1, 0, 10).map(row => row.date)).toEqual(['20230101', '20200325']);
  });

  /** The cursor is a value, so it cannot be invalidated by the writes it drives. */
  it('continues after a given file', () => {
    const [first] = unsettled(db, 1, 0, 1);

    expect(unsettled(db, 1, first!.seq, 10).map(row => row.date)).toEqual(['20200325']);
  });

  /**
   * **The point of walking by id**: a row parked while a sweep is running lands
   * ahead of the cursor, whatever its date. Under date order this row would be
   * behind a cursor that had passed 2023 and sit there until the next round.
   */
  it('reaches a row parked behind the cursor by date', async () => {
    const [, second] = unsettled(db, 1, 0, 10);

    await putFiles(db, [unmeasured('trading/C/C2019-01-01.csv.gz', '20190101')]);

    expect(unsettled(db, 1, second!.seq, 10).map(row => row.date)).toEqual(['20190101']);
  });

  it('stops offering a file once its metadata is known', () => {
    settleFiles(db, [{
      venueId: 1, path: 'trading/A/A2020-03-25.csv.gz', size: 10, etag: 'e',
      modified: '2020-07-28T01:45:29.000Z', seenAt: 'T2',
    }]);

    expect(unsettled(db, 1, 0, 10).map(row => row.path)).toEqual(['trading/B/B2023-01-01.csv.gz']);
    expect(db.prepare(`SELECT size, etag, last_seen FROM file WHERE path LIKE 'trading/A%'`).get())
      .toMatchObject({ size: 10, etag: 'e', last_seen: 'T2' });
  });

  /** Somebody ruled on it; asking the venue again is what they ruled against. */
  /**
   * **Everything parked is outstanding, which is what the table is.** A
   * candidate leaves `wip` by being settled, given up on or withdrawn, and all
   * three delete the row — absence is a ruling about a file, and lives there.
   * So the backlog needs no test for it, on a table that reaches tens of
   * millions of rows per venue.
   */
  it('offers every parked row, and says where each came from', () => {
    expect(unsettled(db, 1, 0, 10).map(row => row.path)).toEqual([
      'trading/B/B2023-01-01.csv.gz',
      'trading/A/A2020-03-25.csv.gz',
    ]);

    expect(unsettled(db, 1, 0, 10).every(row => row.existence === 'confirmed')).toBe(true);
  });

  /** Metadata and absence are separate claims; a probe makes the second only on instruction. */
  it('leaves existence alone unless told otherwise', () => {
    settleFiles(db, [{
      venueId: 1, path: 'trading/A/A2020-03-25.csv.gz', size: 10, etag: 'e',
      modified: null, seenAt: 'T2',
    }]);

    expect(db.prepare(`SELECT existence FROM file WHERE path LIKE 'trading/A%'`).get())
      .toMatchObject({ existence: 'confirmed' });

    settleFiles(db, [{
      venueId: 1, path: 'trading/B/B2023-01-01.csv.gz', size: 10, etag: 'e',
      modified: null, existence: 'absent', seenAt: 'T2',
    }]);

    expect(db.prepare(`SELECT existence FROM file WHERE path LIKE 'trading/B%'`).get())
      .toMatchObject({ existence: 'absent' });
  });

  /**
   * Learning a size for the first time is not the file changing. Otherwise every
   * probed file lands in the trail on its first sighting, and "what changed since
   * I last looked" answers "everything, once".
   */
  it('does not record a first settling as a revision', () => {
    settleFiles(db, [{
      venueId: 1, path: 'trading/A/A2020-03-25.csv.gz', size: 10, etag: 'e',
      modified: null, seenAt: 'T2',
    }]);

    expect(db.prepare('SELECT count(*) n FROM revision').get()).toMatchObject({ n: 0 });
  });

  /**
   * A settlement finishes a discovery. Once a file has arrived it is out of the
   * probe's reach, and anything further about it is a correction — a different
   * path, with its own verification.
   */
  it('does nothing for a file that has already arrived', () => {
    const settle = (etag: string, seenAt: string) => settleFiles(db, [{
      venueId: 1, path: 'trading/A/A2020-03-25.csv.gz', size: 10, etag, modified: null, seenAt,
    }]);

    expect(settle('first', 'T2')).toBe(1);
    expect(settle('second', 'T3')).toBe(0);

    expect(db.prepare(`SELECT etag FROM file WHERE path LIKE 'trading/A%'`).get())
      .toMatchObject({ etag: 'first' });
    expect(db.prepare('SELECT count(*) n FROM revision').get()).toMatchObject({ n: 0 });
  });
});

/**
 * A walk of an HTML index states a path and a date and nothing else, so its
 * three nulls must not be written over what a probe established — otherwise
 * every refresh undoes hours of probing and sends it round again from nothing.
 */
describe('a sighting that states nothing', () => {
  const indexed = (): CatalogFile =>
    file('trading/A/A2020-03-25.csv.gz', { date: '20200325', size: null, etag: null, modified: null });

  beforeEach(async () => {
    putVenue(db, 'bybit', 'https://public.bybit.com', '');
    await putFiles(db, [indexed()]);
    settleFiles(db, [{
      venueId: 1, path: 'trading/A/A2020-03-25.csv.gz',
      size: 121118, etag: 'abc', modified: '2020-07-28T01:45:29.000Z', seenAt: 'T2',
    }]);
  });

  it('leaves what is known when the venue says nothing', async () => {
    await putFiles(db, [indexed()]);

    expect(db.prepare('SELECT size, etag FROM file').get()).toMatchObject({ size: 121118, etag: 'abc' });
  });

  it('does not call silence a change', async () => {
    await putFiles(db, [indexed()]);

    expect(db.prepare('SELECT count(*) n FROM revision').get()).toMatchObject({ n: 0 });
  });

  it('does not send the probe round again', async () => {
    await putFiles(db, [indexed()]);

    expect(unsettled(db, 1, 0, 10)).toHaveLength(0);
  });

  /** A venue that does state its metadata still overwrites, as it always did. */
  it('still takes what a listing venue states', async () => {
    await putFiles(db, [file('trading/A/A2020-03-25.csv.gz',
      { date: '20200325', size: 999, etag: 'changed', modified: 'later', seenAt: 'T3' })]);

    expect(db.prepare('SELECT size, etag FROM file').get()).toMatchObject({ size: 999, etag: 'changed' });

    // The trail keeps what was displaced, which is what the probe had settled.
    expect(db.prepare('SELECT size, etag FROM revision').all())
      .toMatchObject([{ size: 121118, etag: 'abc' }]);
  });
});

describe('completion', () => {
  it('names every ancestor, longest last', () => {
    expect(ancestorsOf('spot/monthly/klines/'))
      .toEqual(['', 'spot/', 'spot/monthly/', 'spot/monthly/klines/']);
  });

  it('treats the empty prefix as the whole venue', () => {
    expect(ancestorsOf('')).toEqual(['']);
  });

  /**
   * A walk of `spot/` settles everything beneath it, so a question about a
   * deeper prefix is answered by the ancestor.
   */
  it('answers a child from its walked ancestor', () => {
    const id = putVenue(db, 'binance', 'https://x', 'data/');

    closeRun(db, partitionsFor(id, ['spot/'])[0]!.id);

    expect(establishedAt(db, id, 'spot/monthly/klines/')).not.toBeNull();
    expect(establishedAt(db, id, 'futures/')).toBeNull();
  });

  /** An unfinished walk establishes nothing — it has keyspace still unread. */
  it('does not count a walk still under way', () => {
    const id = putVenue(db, 'binance', 'https://x', 'data/');

    partitionsFor(id, ['spot/']);

    expect(establishedAt(db, id, 'spot/')).toBeNull();
  });

  /**
   * The one that matters most: an open job must not answer for the venue. The
   * job sits at the empty scope, every prefix's first ancestor, so closing it
   * while a partition is still unread would tell every consumer the whole venue
   * was established.
   */
  it('establishes nothing for a venue whose job is still open', () => {
    const id         = putVenue(db, 'binance', 'https://x', 'data/');
    const partitions = partitionsFor(id, ['spot/', 'futures/']);

    closeRun(db, partitions[0]!.id);

    expect(establishedAt(db, id, 'spot/')).not.toBeNull();
    expect(establishedAt(db, id, '')).toBeNull();
    expect(establishedAt(db, id, 'option/')).toBeNull();
  });

  /**
   * The honest claim is the moment the walk **began**, not when it ended. A
   * walk guarantees the archive as it was at its start; anything it caught later
   * is incidental, and dating it by the finish would claim hours or days it
   * never looked at.
   */
  it('reports when the walk started, not when it finished', async () => {
    const id  = putVenue(db, 'binance', 'https://x', 'data/');
    const run = partitionsFor(id, ['spot/'])[0]!;

    await new Promise(r => setTimeout(r, 5));

    closeRun(db, run.id);

    expect(establishedAt(db, id, 'spot/')).toBe(run.started);

    const row = db.prepare('SELECT completed FROM run WHERE id = ?')
      .get(run.id) as { completed: string };

    expect(row.completed).not.toBe(run.started);
  });

  /** A later job supersedes an earlier one, giving a fresher snapshot. */
  it('reports the most recent completed walk', async () => {
    const id    = putVenue(db, 'binance', 'https://x', 'data/');
    const first = partitionsFor(id, ['spot/'])[0]!;

    closeRun(db, first.id);
    closeRun(db, openJob(db, id, 'walk')!.id);

    await new Promise(r => setTimeout(r, 5));

    const second = partitionsFor(id, ['spot/'])[0]!;

    closeRun(db, second.id);

    expect(establishedAt(db, id, 'spot/')).toBe(second.started);
  });

  /**
   * Several ancestors can qualify at once, and each is a true statement about
   * this prefix. The strongest is the most recent — anything else lets a
   * venue-wide pass from last month shadow a walk of this prefix from an hour
   * ago and understate what is known.
   */
  it('prefers the freshest ancestor, not the shortest', async () => {
    const id = putVenue(db, 'binance', 'https://x', 'data/');

    closeRun(db, partitionsFor(id, ['spot/'])[0]!.id);
    closeRun(db, openJob(db, id, 'walk')!.id);

    await new Promise(r => setTimeout(r, 5));

    const later = partitionsFor(id, ['spot/'])[0]!;

    closeRun(db, later.id);

    expect(establishedAt(db, id, 'spot/monthly/')).toBe(later.started);
  });

  /** History is kept, so every attempt at a prefix remains inspectable. */
  it('keeps each walk as its own row', () => {
    const id = putVenue(db, 'binance', 'https://x', 'data/');

    closeRun(db, partitionsFor(id, ['spot/'])[0]!.id);
    closeRun(db, openJob(db, id, 'walk')!.id);
    closeRun(db, partitionsFor(id, ['spot/'])[0]!.id);

    expect(db.prepare(`SELECT count(*) n FROM run WHERE scope = 'spot/'`).get())
      .toMatchObject({ n: 2 });
  });
});

/**
 * A job is one pass over a venue: the row at the empty scope, plus one partition
 * per prefix, created together. Everything about resuming follows from the
 * partitions being **read back** rather than re-derived.
 */
describe('jobs', () => {
  it('opens the job and every partition together', () => {
    const id  = putVenue(db, 'binance', 'https://x', 'data/');
    const job = beginJob(db, id, 'walk', ['spot/', 'futures/']);

    expect(job.scope).toBe('');
    expect(openPartitions(db, id, 'walk').map(p => p.scope)).toEqual(['spot/', 'futures/']);
  });

  /**
   * One epoch for the whole job, so a partition walked hours later still claims
   * the archive as it was when the job began — the conservative direction.
   */
  it('gives every row in a job the same epoch', () => {
    const id  = putVenue(db, 'binance', 'https://x', 'data/');
    const job = beginJob(db, id, 'walk', ['spot/', 'futures/']);

    for (const each of openPartitions(db, id, 'walk')) expect(each.started).toBe(job.started);
  });

  /**
   * The work list is what is **left**, not what was planned. A partition leaves
   * it by being walked to exhaustion, which is why resuming needs no record of
   * what an earlier attempt managed.
   */
  it('hands back only the partitions still holding unread keyspace', () => {
    const id = putVenue(db, 'binance', 'https://x', 'data/');

    beginJob(db, id, 'walk', ['spot/', 'futures/', 'option/']);

    closeRun(db, openPartitions(db, id, 'walk')[0]!.id);

    expect(openPartitions(db, id, 'walk').map(p => p.scope)).toEqual(['futures/', 'option/']);
  });

  /**
   * A survey of any size will be interrupted. The cursor riding along with the
   * partition is the difference between an interruption and a disaster.
   */
  it('carries each partition cursor back on a resume', () => {
    const id = putVenue(db, 'binance', 'https://x', 'data/');

    beginJob(db, id, 'walk', ['spot/', 'futures/']);

    const [spot] = openPartitions(db, id, 'walk');

    advanceRun(db, spot!.id, 'spot/x.zip', 1, 500);

    expect(openPartitions(db, id, 'walk')[0]).toMatchObject({
      id: spot!.id, scope: 'spot/', cursor: 'spot/x.zip', requests: 1, found: 500,
    });
  });

  /** Resuming does not move the target, so the original start is preserved. */
  it('keeps the original start across a resume', async () => {
    const id  = putVenue(db, 'binance', 'https://x', 'data/');
    const job = beginJob(db, id, 'walk', ['spot/']);

    await new Promise(r => setTimeout(r, 5));

    expect(openJob(db, id, 'walk')!.started).toBe(job.started);
    expect(openPartitions(db, id, 'walk')[0]!.started).toBe(job.started);
  });

  it('has no open job once the job row is closed', () => {
    const id = putVenue(db, 'binance', 'https://x', 'data/');

    closeRun(db, beginJob(db, id, 'walk', ['spot/']).id);

    expect(openJob(db, id, 'walk')).toBeNull();
  });

  /**
   * Atomicity is what makes the partitions safe to treat as the work list: a
   * half-written set would look exactly like a finished one, and the partitions
   * never written would be skipped in silence. Here the second job collides with
   * the first on the open-job index, and must leave nothing behind.
   */
  it('writes no partitions at all when the job cannot be opened', () => {
    const id = putVenue(db, 'binance', 'https://x', 'data/');

    beginJob(db, id, 'walk', ['spot/']);

    expect(() => beginJob(db, id, 'walk', ['futures/', 'option/'])).toThrow();
    expect(openPartitions(db, id, 'walk').map(p => p.scope)).toEqual(['spot/']);
  });

  /** The empty scope is the job. A partition there would collide with it. */
  it('refuses a partition at the empty scope', () => {
    const id = putVenue(db, 'binance', 'https://x', 'data/');

    expect(() => beginJob(db, id, 'walk', ['spot/', ''])).toThrow(/empty scope/);
  });

  it('keeps a probe job apart from a walk', () => {
    const id = putVenue(db, 'binance', 'https://x', 'data/');

    beginJob(db, id, 'walk', ['spot/']);
    beginJob(db, id, 'probe', ['spot/']);

    expect(openJob(db, id, 'walk')!.id).not.toBe(openJob(db, id, 'probe')!.id);
    expect(openPartitions(db, id, 'probe')).toHaveLength(1);
  });
});

/**
 * The half of exclusion that can only be listed. Rows are maintained by hand as
 * bad files are found, and nothing in this codebase writes them at runtime — so
 * what is tested here is that they can be read back per venue and matched
 * exactly.
 *
 * A row added by hand on a running catalog applies at once; a migration carrying
 * the same row is what stops the next deployment dropping it again. Both, for
 * every one found.
 */
describe('exclusions', () => {
  const exclude = (venueId: number, path: string, reason: string) =>
    db.prepare('INSERT INTO exclusion (venue_id, path, reason) VALUES (?, ?, ?)')
      .run(venueId, path, reason);

  it('reads back only this venue\'s excluded files', () => {
    const gate  = putVenue(db, 'gate', 'https://g', '');
    const bybit = putVenue(db, 'bybit', 'https://b', '');

    exclude(gate, 'futures/trades/BTC_USDT-202107.csv.gz', 'truncated copy of spot');
    exclude(bybit, 'trading/DOTUSD/DOTUSDT2021-12-06.csv.gz', 'misfiled, holds DOTUSDT');

    expect(exclusionsFor(db, gate)).toEqual(['futures/trades/BTC_USDT-202107.csv.gz']);
    expect(exclusionsFor(db, bybit)).toEqual(['trading/DOTUSD/DOTUSDT2021-12-06.csv.gz']);
  });

  /**
   * What ships as migrations, checked against the venue rows the migrations
   * create — an exclusion pointing at the wrong venue id excludes nothing.
   *
   * The 85 are gate's 2021-07 month, where the futures URL served spot files;
   * the two others are zero-byte upload tests left in the bucket. Both classes
   * have to survive a rebuild, because gate still serves the same bytes.
   *
   * **Given room deliberately.** This builds a whole second catalog — every
   * migration, seeds included — and it cannot use `seedData: false`, because the
   * exclusions it is asserting are themselves shipped rows. The default five
   * seconds made it fail on a busy machine and pass on an idle one, which is the
   * least useful thing a test can do.
   *
   * **TEMPORARY, the larger figure.** While the seed experiments are wired in, a
   * seeded catalog plants 114,295 series rather than the shipped seeds' 37,057
   * and takes about five seconds to open. Put this back to `20_000` with the
   * rest of the experiment.
   */
  it('ships the known-bad files a fresh catalog already knows about', () => {
    const fresh  = openCatalog(join(dir, 'shipped.db'));
    const [gate] = venueIds(fresh, 'gate');
    const rows   = exclusionsFor(fresh, gate!);

    expect(rows).toHaveLength(87);
    expect(rows).toContain('futures_usdt/candlesticks_10s/202107/123');
    expect(rows).toContain('futures_btc/mark_prices/202107/hello/123');

    const substituted = rows.filter(one => one.startsWith('futures_usdt/trades/202107/'));

    expect(substituted).toHaveLength(85);
    expect(substituted).toContain('futures_usdt/trades/202107/SUN_USDT-202107.csv.gz');

    fresh.close();
  }, 60_000);

  it('has nothing to say about a venue with no bad files', () => {
    expect(exclusionsFor(db, putVenue(db, 'kucoin', 'https://k', 'data/'))).toEqual([]);
  });

  /** Excluding the same file twice is a mistake, not two rows. */
  it('refuses a duplicate', () => {
    const gate = putVenue(db, 'gate', 'https://g', '');

    exclude(gate, 'futures/trades/x.csv.gz', 'truncated');

    expect(() => exclude(gate, 'futures/trades/x.csv.gz', 'again')).toThrow();
  });
});

describe('venues', () => {
  it('is idempotent and updates where files are served from', () => {
    const first = putVenue(db, 'binance', 'https://old', 'data/');
    const again = putVenue(db, 'binance', 'https://new', 'data/');

    expect(again).toBe(first);
    expect(db.prepare('SELECT base FROM venue WHERE id = ?').get(first))
      .toMatchObject({ base: 'https://new' });
  });
});

describe('migrations', () => {
  /** A new file is born at the current shape, so nothing is ever migrated into it. */
  it('stamps a fresh catalog at the latest version', () => {
    expect(version(db)).toBe(SCHEMA_VERSION);
  });

  it('runs nothing on a database already current', () => {
    expect(migrate(db)).toBe(0);
  });

  /**
   * **Every database runs the chain, including a brand new one.**
   *
   * The case this replaced built a database in the shape that existed before any
   * migration and checked it was carried forward. That history is gone on
   * purpose — it was eight deltas from shapes nothing writes down any more, and
   * replaying them from empty could only fail — so what is worth asserting now
   * is that no database is exempt.
   */
  it('runs every migration against a database that has never been opened', () => {
    const fresh = openCatalog(join(dir, 'fresh.db'), { seedData: false });

    expect(version(fresh)).toBe(SCHEMA_VERSION);
    expect(fresh.prepare(`SELECT count(*) n FROM sqlite_master WHERE name='series'`).get())
      .toMatchObject({ n: 1 });

    fresh.close();
  });

  /** Opening again finds nothing left to do rather than repeating anything. */
  it('applies nothing on a second open', () => {
    const path = join(dir, 'twice.db');

    openCatalog(path, { seedData: false }).close();

    const again = openCatalog(path, { seedData: false });

    expect(migrate(again, false)).toBe(0);

    again.close();
  });

  /**
   * **Declining shipped rows still advances the version.** A caller that asked
   * for schema only has what it asked for, and must not have that migration
   * attempted again behind its back the next time the file is opened.
   */
  it('does not retry a declined seed on the next open', () => {
    const path = join(dir, 'noseed.db');

    openCatalog(path, { seedData: false }).close();

    const again = openCatalog(path, { seedData: false });

    expect(version(again)).toBe(SCHEMA_VERSION);
    expect(again.prepare('SELECT count(*) n FROM series').get()).toMatchObject({ n: 0 });

    again.close();
  });

  /**
   * An older binary pointed at a newer catalog must refuse rather than write
   * rows it cannot describe.
   */
  it('refuses a catalog from the future', () => {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);

    expect(() => migrate(db)).toThrow(/only knows/);
  });
});

/**
 * What a synchronous database costs the rest of the process, and what bounds it.
 *
 * `node:sqlite` is synchronous, so every row written is a row nothing else runs
 * during. That is affordable in slices and ruinous in aggregate, and the
 * difference is the whole of this.
 */
describe('holding the thread', () => {
  const many = (venueId: number, count: number): CatalogFile[] =>
    Array.from({ length: count }, (_v, at) => ({
      ...file(`p/${String(at).padStart(6, '0')}.zip`), venueId,
    }));

  /**
   * **The bug this replaced.** Slicing one write bounds one write: node runs the
   * whole immediate queue in a single turn, so every writer that happens to be
   * mid-page takes its slice in the *same* turn and the loop is held for the sum
   * of them. Measured on the running service, that was 3.5 seconds.
   *
   * So the test is not "does a write yield" — it did before — but "does the loop
   * turn over **between** writers", which is what the shared queue buys.
   */
  it('lets the loop turn over between concurrent writers', async () => {
    const venues = [1, 2, 3, 4, 5, 6].map(at => putVenue(db, `v${at}`, 'https://x', ''));

    let turns   = 0;
    let writing = true;

    /**
     * **Ticks for as long as the writing lasts, rather than up to a fixed
     * count.** A cap is a second thing that can decide the answer: a machine
     * slow enough to need more turns than it allows would fail for having done
     * the right thing more times than expected.
     */
    const tick = () => { turns++; if (writing) setImmediate(tick); };

    setImmediate(tick);

    const began = Date.now();

    await Promise.all(venues.map(venueId => putFiles(db, many(venueId, 4_000))));

    const elapsed = Date.now() - began;

    writing = false;

    /**
     * **Measured against how long the writing took, never against a fixed
     * count.**
     *
     * One slice holds the thread for `BREATH_MS` and then hands it back, so a
     * correct run turns the loop over about once per slice. The per-caller
     * budget this replaced ran all six writers' slices in the *same* turn, so
     * it turned over about once per six. Half way between the two is the line,
     * and it separates them by the same margin whether these rows take the
     * machine a tenth of a second or ten seconds.
     *
     * `turns > 10` was a floor on how *slow* the machine had to be: it counted
     * slices, and a machine quick enough to write all of this inside ten of
     * them failed for being fast.
     */
    expect(turns).toBeGreaterThanOrEqual(elapsed / (2 * BREATH_MS));

    for (const venueId of venues)
      expect(db.prepare('SELECT COUNT(*) n FROM file WHERE venue_id = ?').get(venueId))
        .toMatchObject({ n: 4_000 });
  }, 60_000);

  /** Every row still lands, and a page written twice says what writing it once said. */
  it('writes the same thing whether it took one slice or twenty', async () => {
    const venueId = putVenue(db, 'twice', 'https://x', '');

    await putFiles(db, many(venueId, 2_000));
    await putFiles(db, many(venueId, 2_000));

    expect(db.prepare('SELECT COUNT(*) n FROM file WHERE venue_id = ?').get(venueId))
      .toMatchObject({ n: 2_000 });
  }, 60_000);
});
