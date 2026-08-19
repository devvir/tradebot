import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { venues } from '../src/catalog';
import { openCatalog } from '../src/database';
import { _test_relative } from '../src/paths';
import { _test_pool } from '../src/pool';
import { _test_catalogued } from '../src/survey';
import { binance } from '../src/adapters/binance';
import { htx } from '../src/adapters/htx';
import { kucoin } from '../src/adapters/kucoin';
import type { Adapter, Listed } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';
import { addressVenues } from '../src/venues';

/**
 * A venue of its own, paced fast: these tests are about where the gate sits,
 * not about what any real venue tolerates, and a shared one would carry a
 * latched block from one test into the next.
 */
const quick: Adapter = { ...htx, name: 'quick', pacing: { perSecond: 1000, standDownMs: 5_000 } };

/**
 * The address these tests actually request. The gate is keyed on the host, so an
 * assertion has to name the same one the fetch used — `quick.list` is a
 * different machine and would answer about a budget nothing here spent.
 */
const VENUE = 'https://venue/';

const listed = (key: string): Listed =>
  ({ key, size: 10, etag: 'e', modified: '2025-01-01T00:00:00.000Z' });

/**
 * A catalog for the one thing these rows can touch: recording the series a path
 * belongs to. None of the venues below reads its own paths yet, so nothing here
 * writes — but the seam takes a database and a test should hand it a real one.
 */
let home: string;
let db:   DatabaseSync;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'survey-'));
  db   = openCatalog(join(home, 'catalog.db'), { seedData: false });
});

afterAll(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

/**
 * As a walk catalogues them: `since` is what creates the series a path is read
 * into, and without one these keys resolve to no series and are set aside as
 * unreadable instead.
 */
const catalogued = (adapter: Adapter, venueId: number, keys: readonly Listed[]) =>
  _test_catalogued(db, adapter, venueId, keys, new Date('2026-01-01T00:00:00.000Z'));

describe('turning listed keys into catalog rows', () => {
  it('stores the path with the venue root removed', () => {
    const [row] = catalogued(kucoin, 1,
      [listed('data/spot/daily/trades/A/A-trades-2024-07-03.zip')]);

    expect(row!.path).toBe('spot/daily/trades/A/A-trades-2024-07-03.zip');
  });

  /**
   * Binance surveys from the bucket root, so nothing is stripped and a path
   * stays self-describing — which is what makes `data/…` and `data3/…` both
   * reconstructable as `base + '/' + path`.
   */
  it('leaves the path whole for a venue with no root', () => {
    const [row] = catalogued(binance, 1,
      [listed('data/spot/monthly/trades/BTCUSDT/BTCUSDT-trades-2025-03.zip')]);

    expect(row!.path).toBe('data/spot/monthly/trades/BTCUSDT/BTCUSDT-trades-2025-03.zip');
  });

  /** Staging and stray keys are refused before they can reach the catalog. */
  it('refuses what the venue says is not archive', () => {
    const rows = catalogued(binance, 1, [
      listed('data2/data/spot/trades/A/A-trades-2020-12.zip'),
      listed('data3/liquidationSnapshot'),
      listed('data3/liquidationSnapshot/BTCUSDT/BTCUSDT-liquidationSnapshot-2023-11-22.zip'),
    ]);

    expect(rows.map(r => r.path))
      .toEqual(['data3/liquidationSnapshot/BTCUSDT/BTCUSDT-liquidationSnapshot-2023-11-22.zip']);
  });

  /**
   * Halves the catalog, and does it without any rule naming `.CHECKSUM` —
   * the sidecar simply carries no date the adapter recognises.
   */
  it('drops checksum sidecars, which are half of every page', () => {
    const rows = catalogued(binance, 1, [
      listed('data/spot/monthly/trades/BTCUSDT/BTCUSDT-trades-2025-03.zip'),
      listed('data/spot/monthly/trades/BTCUSDT/BTCUSDT-trades-2025-03.zip.CHECKSUM'),
    ]);

    expect(rows).toHaveLength(1);
  });

  /**
   * A listing cannot name a key that is not there, so a walk establishes
   * existence rather than supposing it. Probe venues will arrive as `unknown`.
   */
  it('records a walked file as confirmed', () => {
    const [row] = catalogued(htx, 2,
      [listed('historical_data/spot/daily/trades/BTC-USDT/BTC-USDT-trades-2026-02-01.zip')]);

    expect(row!.existence).toBe('confirmed');
    expect(row!.venueId).toBe(2);
  });

  it('carries the venue metadata through untouched', () => {
    const [row] = catalogued(htx, 1,
      [{ key: 'historical_data/spot/daily/trades/BTC-USDT/BTC-USDT-trades-2026-02-01.zip',
        size: 4096, etag: 'abc', modified: 'then' }]);

    expect(row).toMatchObject({ size: 4096, etag: 'abc', modified: 'then' });
  });

});

describe('stripping the root', () => {
  it('removes it when present', () => {
    expect(_test_relative(kucoin, 'data/spot/x.zip')).toBe('spot/x.zip');
  });

  /** An empty root strips nothing, so the path is the key. */
  it('leaves the key whole when the venue has no root', () => {
    expect(_test_relative(binance, 'data/spot/x.zip')).toBe('data/spot/x.zip');
  });

  /** A key that does not start with the root is left alone rather than mangled. */
  it('leaves an unexpected key untouched', () => {
    expect(_test_relative(kucoin, 'other/x.zip')).toBe('other/x.zip');
  });

  /**
   * HTX publishes two archives in one bucket, so nothing is stripped and the
   * path says which tree a file came from.
   */
  it('keeps both of a venue\'s trees distinguishable', () => {
    expect(_test_relative(htx, 'historical_data/spot/daily/trades/A/x.zip'))
      .toBe('historical_data/spot/daily/trades/A/x.zip');
    expect(_test_relative(htx, 'data/trades/spot/daily/A/x.zip'))
      .toBe('data/trades/spot/daily/A/x.zip');
  });
});

describe('the partition pool', () => {
  it('runs every item', async () => {
    const seen: number[] = [];

    await _test_pool([1, 2, 3, 4, 5], 2, async (n) => { seen.push(n); });

    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('never exceeds the limit', async () => {
    let running = 0;
    let peak    = 0;

    await _test_pool([1, 2, 3, 4, 5, 6], 2, async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise(r => setTimeout(r, 1));
      running--;
    });

    expect(peak).toBeLessThanOrEqual(2);
  });

  /**
   * One partition failing must not abandon the rest of the archive — it keeps
   * its cursor and is retried while the others carry on.
   */
  it('carries on when an item throws', async () => {
    const done: number[] = [];

    await _test_pool([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('listing failed');

      done.push(n);
    }).catch(() => {});

    expect(done.sort()).toEqual([1, 3]);
  });

  /**
   * And it must not go unmentioned. Swallowing here is what let a survey report
   * success with a partition unread — the failure has to reach a caller that can
   * decline to close the job.
   */
  it('reports the failures once every lane has drained', async () => {
    const done: number[] = [];

    const run = _test_pool([1, 2, 3, 4], 2, async (n) => {
      if (n % 2 === 0) throw new Error(`item ${n} failed`);

      done.push(n);
    });

    await expect(run).rejects.toThrow(/2 of 4 items failed/);

    // Raised only after the lanes drained, so the survivors all ran.
    expect(done.sort()).toEqual([1, 3]);
  });
});

describe('http retry policy', async () => {
  const { _test_retryAfterMs } = await import('../src/http');

  it('obeys a retry-after given in seconds', () => {
    expect(_test_retryAfterMs('2')).toBe(2000);
  });

  it('obeys a retry-after given as a date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    expect(_test_retryAfterMs('Thu, 01 Jan 2026 00:00:05 GMT')).toBe(5000);

    vi.useRealTimers();
  });

  it('ignores a header it cannot read', () => {
    expect(_test_retryAfterMs('soon')).toBeNull();
    expect(_test_retryAfterMs(null)).toBeNull();
  });

  /** A venue is the authority on its own pace: a long wait is honoured, not capped. */
  it('honours a long retry-after in full', () => {
    expect(_test_retryAfterMs('300')).toBe(300_000);
  });
});

describe('a listing that hangs', async () => {
  const { fetchText } = await import('../src/http');

  const timeout = (): Error =>
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

  it('gives every request a deadline', async () => {
    const fetched = vi.fn().mockResolvedValue({ ok: true, text: async () => '<ok/>' });

    vi.stubGlobal('fetch', fetched);
    await fetchText(quick, 'https://venue/?prefix=spot/');

    expect(fetched.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);

    vi.unstubAllGlobals();
  });

  /** A timeout is a transport failure like any other, so the page is asked for again. */
  it('retries rather than skipping the page', async () => {
    const fetched = vi.fn()
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce({ ok: true, text: async () => '<ListBucketResult/>' });

    vi.stubGlobal('fetch', fetched);

    await expect(fetchText(quick, 'https://venue/?prefix=spot/'))
      .resolves.toContain('ListBucketResult');
    expect(fetched).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });

  /**
   * And when it never answers, the caller is told — never handed an empty listing.
   *
   * Allowed longer than the default: this walks the whole backoff ladder, whose
   * jitter reaches ~7.5 s across four waits.
   */
  it('fails loudly once its attempts are spent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout()));

    await expect(fetchText(quick, 'https://venue/?prefix=spot/'))
      .rejects.toThrow(/aborted due to timeout/);

    vi.unstubAllGlobals();
  }, 20_000);
});

/**
 * The walk is most of the traffic a venue sees, so a limiter it does not pass
 * through is not a limit. It is enforced at the fetch, which is the one place
 * every caller and every retry goes.
 */
describe('the gate every request passes', async () => {
  const { fetchText }  = await import('../src/http');
  const { _test_paces, paceFor, REFUSALS_BEFORE_BLOCK } = await import('../src/pace');

  const refusal = (headers: Record<string, string>) =>
    ({ ok: false, status: 403, headers: new Headers(headers), text: async () => '' });

  const cloudfront = () => refusal({ server: 'CloudFront', 'x-cache': 'Error from cloudfront' });

  beforeEach(() => _test_paces.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('counts a walk request against the venue, not just a probe', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '<ok/>' }));

    await fetchText(quick, 'https://venue/?prefix=spot/');

    expect(paceFor(quick, VENUE).rates().lastSecond).toBe(1);
  });

  /**
   * Five attempts inside one call are five requests the venue sees. Taking the
   * slot around the call instead of inside it lets a retry ladder go out at five
   * times the cap, at exactly the moment a venue is already unhappy.
   */
  it('counts every retry, not one per call', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(new Error('other side closed'))
      .mockRejectedValueOnce(new Error('other side closed'))
      .mockResolvedValue({ ok: true, text: async () => '<ok/>' }));

    await fetchText(quick, 'https://venue/?prefix=spot/');

    expect(paceFor(quick, VENUE).rates().sentTotal).toBe(3);
  });

  /**
   * A CloudFront refusal names no key, so it is aimed at the address — but one
   * of them is a bad second rather than a ban, so the latch waits for a run of
   * them with nothing answering in between.
   */
  it('latches the whole venue once a run of requests is blocked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(cloudfront()));

    for (let i = 0; i < REFUSALS_BEFORE_BLOCK - 1; i++)
      await expect(fetchText(quick, 'https://venue/?prefix=spot/')).rejects.toThrow(/Refused 403/);

    expect(paceFor(quick, VENUE).blockedFor()).toBe(0);

    await expect(fetchText(quick, 'https://venue/?prefix=spot/')).rejects.toThrow(/Refused 403/);

    expect(paceFor(quick, VENUE).blockedFor()).toBeGreaterThan(0);
  });

  /**
   * A ban lapses only while nothing is asking, so the retry ladder is exactly
   * the wrong response to one — it spends four more requests confirming it.
   */
  it('does not retry a block', async () => {
    const fetched = vi.fn().mockResolvedValue(cloudfront());

    vi.stubGlobal('fetch', fetched);

    await expect(fetchText(quick, 'https://venue/?prefix=spot/')).rejects.toThrow(/Refused 403/);
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  /** S3 names the key it is refusing, and that says nothing about the address. */
  it('leaves the venue running when a refusal names a key', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValue(refusal({ server: 'AmazonS3', 'x-amz-error-code': 'AccessDenied' })));

    await expect(fetchText(quick, 'https://venue/?prefix=spot/')).rejects.toThrow(/Refused 403/);

    expect(paceFor(quick, VENUE).blockedFor()).toBe(0);
  });

  /**
   * The headers are the only thing separating the two cases above, and a
   * `Headers` logged as an object serialises to `{}` — so they are carried out
   * flat as well.
   */
  it('carries the headers somewhere a log can reach them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(cloudfront()));

    await expect(fetchText(quick, 'https://venue/?prefix=spot/')).rejects.toMatchObject({
      detail: { server: 'CloudFront', cache: 'Error from cloudfront', amzError: null },
    });
  });
});

/**
 * Give the adapters their addresses, as startup does.
 *
 * **Where a venue is lives in the `venue` table**, written by a migration, so an
 * adapter carries no address until it is handed one. A test that uses a real
 * venue needs that step; one that invents its own venue does not.
 */
const address = () => {
  const here = mkdtempSync(join(tmpdir(), 'addresses-'));
  const db   = openCatalog(join(here, 'catalog.db'));

  addressVenues(venues(db));

  db.close();
  rmSync(here, { recursive: true, force: true });
};

address();
