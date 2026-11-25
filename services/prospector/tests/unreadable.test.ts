import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@devvir/service-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WITHDRAWALS_LOG, putVenue, venueIds } from '../src/catalog';
import { listing } from '../src/context';
import { openCatalog } from '../src/database';
import { MalformedListing, Refused, fetchPage } from '../src/http';
import { _test_paces } from '../src/pace';
import { asSeries } from '../src/paths';
import { s3 } from '../src/scanners/s3';
import { _test_retryWait as retryWait, surveyVenue } from '../src/survey';
import type { Adapter, Config, ListingContext, Scanner } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * **A success whose body is not a listing is a fault, never an empty listing.**
 * An empty final page withdraws whatever was catalogued in its range, so a
 * maintenance page served with a 200 must leave the catalog exactly as it was:
 * the page is asked for again, and the partition closes only on a real listing.
 */

/** A venue of its own, paced fast, on a host nothing else in this file asks. */
const strict: Adapter<Scanner<ListingContext>> = {
  name:    'strict',
  scanner: s3,
  base:    'https://strict.example',
  keyRoot: '',
  pacing:  { perSecond: 1000, standDownMs: 5_000 },
  getContext: async () => listing(strict),
  dateOf:  (path) => /(\d{4})-(\d{2})-(\d{2})\.zip$/.exec(path)?.slice(1, 4).join('') ?? null,

  /** Every dated key reads into one series per directory, so it is catalogued. */
  inspectUrl: (path) => {
    const at = /^(\w+)\/(\w+)-(\d{4})-(\d{2})-(\d{2})\.zip$/.exec(path);

    return at
      ? asSeries(path, { market: 'spot', dataset: at[1]!, symbol: at[2]!, date: at.slice(3, 6).join('') })
      : { of: 'unknown', date: null };
  },
};

const HTML = '<html><body><h1>Down for maintenance</h1></body></html>';

const object = (key: string) =>
  `<Contents><Key>${key}</Key><LastModified>2025-01-01T00:00:00.000Z</LastModified>`
  + `<ETag>&quot;e&quot;</ETag><Size>10</Size></Contents>`;

const listingOf = (keys: string[], truncated: boolean, dirs: string[] = []) =>
  `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${keys.map(object).join('')}`
  + `${dirs.map(dir => `<CommonPrefixes><Prefix>${dir}</Prefix></CommonPrefixes>`).join('')}</ListBucketResult>`;

/** The bucket's keys: two directories, so two partitions, one of them three files walked two to a page. */
const KEYS = ['d/A-2025-01-01.zip', 'd/A-2025-01-02.zip', 'd/A-2025-01-03.zip', 'e/B-2025-01-01.zip'];

/**
 * A bucket that answers as S3 does, two keys to a page, and serves the next
 * walk page whose marker `hiccup` names with a maintenance page instead, once.
 */
const bucket = (hiccup: { marker: string | null }) => vi.fn(async (url: string) => {
  const query  = new URL(url).searchParams;
  const prefix = query.get('prefix') ?? '';
  const marker = query.get('marker');
  const max    = Math.min(Number(query.get('max-keys')), 2);
  const under  = KEYS.filter(key => key.startsWith(prefix) && (marker === null || key > marker));

  if (marker !== null && marker === hiccup.marker && ! query.has('delimiter') && max === 2) {
    hiccup.marker = null;

    return new Response(HTML, { headers: { 'content-type': 'text/html' } });
  }

  if (query.has('delimiter')) {
    const files = under.filter(key => ! key.slice(prefix.length).includes('/'));
    const dirs  = [...new Set(under.filter(key => key.slice(prefix.length).includes('/'))
      .map(key => prefix + key.slice(prefix.length).split('/')[0] + '/'))];

    return new Response(listingOf(files, false, dirs));
  }

  return new Response(listingOf(under.slice(0, max), under.length > max));
});

const config: Config = { catalogDir: '', token: '', port: 0, venues: [], concurrency: 2 };

let dir: string;
let db:  DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'unreadable-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });

  putVenue(db, 'strict', 'https://strict.example', '');
  retryWait(async () => {});
  _test_paces.clear();
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  retryWait(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('fetching a page that is not a listing', () => {
  it('asks again, and hands back the listing that follows', async () => {
    const fetched = vi.fn()
      .mockResolvedValueOnce(new Response(HTML))
      .mockResolvedValueOnce(new Response(listingOf(['d/A-2025-01-01.zip'], false)));

    vi.stubGlobal('fetch', fetched);

    await expect(fetchPage(strict, 'https://strict.example/?prefix=d/', 's3'))
      .resolves.toMatchObject({ listed: [{ key: 'd/A-2025-01-01.zip' }], next: null });
    expect(fetched).toHaveBeenCalledTimes(2);
  });

  it('fails as unreadable, not as a refusal, once asking again stops helping', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(HTML, { headers: { 'content-type': 'text/html' } })));

    const failure = await fetchPage(strict, 'https://strict.example/?prefix=d/', 's3').catch(err => err);

    expect(failure).toBeInstanceOf(MalformedListing);
    expect(failure).not.toBeInstanceOf(Refused);
    expect(failure).toMatchObject({ contentType: 'text/html', url: 'https://strict.example/?prefix=d/' });
    expect(failure.snippet).toContain('Down for maintenance');
  });

  /** The venue answered; it is not a venue that cannot be reached. */
  it('is not counted as a request that never reached the venue', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(HTML)));

    await fetchPage(strict, 'https://strict.example/?prefix=d/', 's3').catch(() => {});

    expect(vi.mocked(logger.warn).mock.calls.map(call => call[1]))
      .not.toContain('Requests not reaching the venue; retrying');
  });

  /** A confirmation that could not be read is no evidence that a file has gone. */
  it('leaves a confirmation unanswered rather than absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(HTML)));

    await expect(s3.confirm(listing(strict), 'd/A-2025-01-01.zip')).rejects.toBeInstanceOf(MalformedListing);
  });
});

describe('a walk served a maintenance page part-way', () => {
  const existence = (): string[] =>
    (db.prepare('SELECT existence FROM file ORDER BY path').all() as { existence: string }[])
      .map(row => row.existence);

  const backlog = (): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM wip').get() as { n: number }).n;

  const withdrawals = (): string[] =>
    (existsSync(join(dir, WITHDRAWALS_LOG)) ? readFileSync(join(dir, WITHDRAWALS_LOG), 'utf8') : '')
      .split('\n').filter(line => line.includes('"withdrawn"'));

  const open = (): { scope: string; cursor: string | null }[] =>
    db.prepare(`SELECT scope, cursor FROM run WHERE venue_id = ? AND scope <> '' AND completed IS NULL`)
      .all(venueIds(db, 'strict')[0]!) as { scope: string; cursor: string | null }[];

  it('withdraws nothing, and closes only on the real listing', async () => {
    vi.stubGlobal('fetch', bucket({ marker: null }));

    expect(await surveyVenue(db, strict, config, 'full')).toMatchObject({ failed: 0 });

    const before = { existence: existence(), backlog: backlog() };

    expect(before.existence).toHaveLength(4);

    const hiccup  = { marker: 'd/A-2025-01-02.zip' };
    const fetched = bucket(hiccup);

    vi.stubGlobal('fetch', fetched);

    expect(await surveyVenue(db, strict, config, 'full')).toMatchObject({ failed: 0 });

    // The maintenance page was served, and the page asked for again behind it.
    expect(hiccup.marker).toBeNull();
    expect(fetched.mock.calls.filter(([url]) => String(url).includes('marker=d/A-2025-01-02.zip'))
      .length).toBeGreaterThanOrEqual(2);

    expect(withdrawals()).toEqual([]);
    expect({ existence: existence(), backlog: backlog() }).toEqual(before);
    expect(open()).toEqual([]);
  });

  it('keeps the partition open, at its cursor, while nothing but the maintenance page comes back', async () => {
    vi.stubGlobal('fetch', bucket({ marker: null }));
    await surveyVenue(db, strict, config, 'full');

    const before = existence();

    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      (String(url).includes('marker=d/A-2025-01-02.zip') && ! String(url).includes('delimiter')
        ? new Response(HTML)
        : bucket({ marker: null })(url))));

    expect(await surveyVenue(db, strict, config, 'full')).toMatchObject({ failed: 1 });

    expect(withdrawals()).toEqual([]);
    expect(existence()).toEqual(before);
    expect(open()).toEqual([expect.objectContaining({ cursor: 'd/A-2025-01-02.zip' })]);
  });
});
