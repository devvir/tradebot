import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFetchService } from '../src/bitmex';
import type { TableConfig } from '../src/types';

vi.mock('../src/utils/throttling', () => ({
  waitIfNeeded: vi.fn().mockResolvedValue(undefined),
  sleep:        vi.fn().mockResolvedValue(undefined),
}));

const BASE_URL = 'https://www.bitmex.com/api/v1';

const mkTable = (overrides: Partial<TableConfig> = {}): TableConfig => ({
  name:     'funding',
  path:     '/funding',
  maxStart: null,
  ...overrides,
});

const okJson = (data: unknown): Response =>
  ({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(data) } as unknown as Response);

const collect = async <T>(iter: AsyncIterable<T>): Promise<T[]> => {
  const result: T[] = [];
  for await (const item of iter) result.push(item);
  return result;
};

// ── oldest ────────────────────────────────────────────────────────────────────

describe('FetchService — oldest', () => {
  beforeEach(() => vi.spyOn(global, 'fetch'));
  afterEach(() => vi.restoreAllMocks());

  it('returns the first row when data exists', async () => {
    const row = { timestamp: '2020-01-01T00:00:00.000Z', price: 7000 };
    vi.mocked(global.fetch).mockResolvedValue(okJson([row]));

    const result = await createFetchService(BASE_URL).oldest(mkTable());

    expect(result).toEqual(row);
  });

  it('returns null when the API returns no rows', async () => {
    vi.mocked(global.fetch).mockResolvedValue(okJson([]));

    const result = await createFetchService(BASE_URL).oldest(mkTable());

    expect(result).toBeNull();
  });

  it('requests exactly one row (count=1)', async () => {
    vi.mocked(global.fetch).mockResolvedValue(okJson([]));

    await createFetchService(BASE_URL).oldest(mkTable());

    const url = new URL(vi.mocked(global.fetch).mock.calls[0][0] as string);
    expect(url.searchParams.get('count')).toBe('1');
  });

  it('applies symbol filter', async () => {
    vi.mocked(global.fetch).mockResolvedValue(okJson([]));

    await createFetchService(BASE_URL).oldest(mkTable(), { symbol: '.BXBT' });

    const url = new URL(vi.mocked(global.fetch).mock.calls[0][0] as string);
    expect(url.searchParams.get('symbol')).toBe('.BXBT');
  });
});

// ── getRows ───────────────────────────────────────────────────────────────────
//
// rowIterator fetches PAGES_PER_BATCH (=10) pages in parallel per iteration.
// An incomplete batch (any page short or empty) triggers a block transition:
// blockStartTime advances to the last seen row's timestamp and start resets to 0.

describe('FetchService — getRows', () => {
  beforeEach(() => vi.spyOn(global, 'fetch'));
  afterEach(() => vi.restoreAllMocks());

  it('yields rows from a partial first page in the batch', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    vi.mocked(global.fetch).mockResolvedValue(okJson(rows));

    const result = await collect(createFetchService(BASE_URL).getRows(mkTable()));

    expect(result).toEqual(rows);
    // 10 fetches issued in the batch; partial first page stops yielding after it.
    // No timestamp on the rows → cannot advance block → returns.
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(10);
  });

  it('paginates across the batch in offset order', async () => {
    const fullRows = (start: number) =>
      Array.from({ length: 500 }, (_, i) => ({ id: start + i }));

    // First batch (no startTime): pages at offsets 0..4500.
    //   Pages 0..1 are full (1000 rows total), page 2 returns 1 row → batch incomplete.
    //   Without a timestamp on the rows the block transition can't fire, so iteration ends.
    vi.mocked(global.fetch).mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('start=0&'))    return okJson(fullRows(0));
      if (u.includes('start=500&'))  return okJson(fullRows(500));
      if (u.includes('start=1000&')) return okJson([{ id: 1000 }]);
      return okJson([]);
    });

    const result = await collect(createFetchService(BASE_URL).getRows(mkTable()));

    expect(result).toHaveLength(1001);
    expect(result[0]).toEqual({ id: 0 });
    expect(result[1000]).toEqual({ id: 1000 });
  });

  it('stops after the first batch when all pages are empty', async () => {
    vi.mocked(global.fetch).mockResolvedValue(okJson([]));

    const result = await collect(createFetchService(BASE_URL).getRows(mkTable()));

    expect(result).toHaveLength(0);
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(10);
  });

  it('applies symbol and startTime filters', async () => {
    vi.mocked(global.fetch).mockResolvedValue(okJson([]));

    await collect(
      createFetchService(BASE_URL).getRows(
        mkTable({ path: '/trade' }),
        { symbol: 'XBTUSD', startTime: '2020-01-01T00:00:00.000Z' },
      ),
    );

    const url = new URL(vi.mocked(global.fetch).mock.calls[0][0] as string);
    expect(url.searchParams.get('symbol')).toBe('XBTUSD');
    expect(url.searchParams.get('startTime')).toBe('2020-01-01T00:00:00.000Z');
  });

  it('issues PAGES_PER_BATCH parallel fetches at offsets [start, start+page, …]', async () => {
    vi.mocked(global.fetch).mockResolvedValue(okJson([]));

    await collect(createFetchService(BASE_URL).getRows(mkTable()));

    const calls  = vi.mocked(global.fetch).mock.calls;
    const starts = calls.map(c => new URL(String(c[0])).searchParams.get('start'));

    expect(starts).toEqual(['0', '500', '1000', '1500', '2000', '2500', '3000', '3500', '4000', '4500']);
  });

  it('preemptively advances the block when a full batch pushes start past maxStart − pageSize', async () => {
    const timestamp = '2020-01-01T00:00:00.000Z';
    const fullPage  = Array.from({ length: 500 }, () => ({ timestamp }));

    // No startTime → return full pages (forces preemptive transition after a full batch).
    // With startTime → return empty (terminates the iterator).
    vi.mocked(global.fetch).mockImplementation(async (url) =>
      String(url).includes('startTime=') ? okJson([]) : okJson(fullPage)
    );

    // maxStart=4999, pageSize=500 → after a full batch start=5000 > 4499 → transition.
    const result = await collect(createFetchService(BASE_URL).getRows(mkTable({ maxStart: 4999 })));

    expect(result).toHaveLength(500 * 10);

    const calls = vi.mocked(global.fetch).mock.calls;
    expect(calls).toHaveLength(20);

    // First batch: 10 calls without startTime.
    for (let i = 0; i < 10; i++)
      expect(String(calls[i]![0])).not.toContain('startTime=');

    // Second batch: 10 calls with startTime, start reset to [0, 500, …, 4500].
    const secondBatchStarts = calls.slice(10).map(c => new URL(String(c[0])).searchParams.get('start'));
    expect(secondBatchStarts).toEqual(['0', '500', '1000', '1500', '2000', '2500', '3000', '3500', '4000', '4500']);

    for (let i = 10; i < 20; i++)
      expect(String(calls[i]![0])).toContain('startTime=');
  });

  it('advances the block when the batch is incomplete (bug bypass)', async () => {
    const timestamp = '2020-01-01T00:00:00.000Z';
    const fullPage  = Array.from({ length: 500 }, () => ({ timestamp }));

    // First batch: page 0 full, pages 1..9 empty (simulates the BitMEX cap mid-batch).
    // Second batch (with startTime): all empty → terminates.
    vi.mocked(global.fetch).mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('startTime='))  return okJson([]);
      if (u.includes('start=0&'))    return okJson(fullPage);
      return okJson([]);
    });

    const result = await collect(createFetchService(BASE_URL).getRows(mkTable()));

    // 500 rows from page 0 of the first batch.
    expect(result).toHaveLength(500);

    // Two batches: 20 calls total. The second batch carries startTime — the transition fired
    // even though the iterator was nowhere near maxStart.
    const calls = vi.mocked(global.fetch).mock.calls;
    expect(calls).toHaveLength(20);

    for (let i = 10; i < 20; i++)
      expect(String(calls[i]![0])).toContain('startTime=');
  });

  it('force-advances the block when a batch ends on its own anchor (no progress)', async () => {
    // Reproduces a backfilled island (e.g. .BUSDP 2023-10-23): querying startTime=T
    // returns a full page then a short page both ending at T, so lastTs === blockStartTime.
    // Re-anchoring to T would re-fetch the identical window forever. The guard commits the
    // batch and force-advances startTime by one millisecond; the next batch is empty → end.
    const T     = '2023-10-23T05:47:40.000Z';
    const TPlus = '2023-10-23T05:47:40.001Z';
    const full  = Array.from({ length: 500 }, () => ({ timestamp: T }));

    const encT = '2023-10-23T05%3A47%3A40.000Z';

    vi.mocked(global.fetch).mockImplementation(async (url) => {
      const u = String(url);

      if (u.includes(`startTime=${encT}`) && u.includes('start=0&'))   return okJson(full);
      if (u.includes(`startTime=${encT}`) && u.includes('start=500&')) return okJson([{ timestamp: T }]);

      return okJson([]); // remaining pages of batch 1, and all of batch 2 (startTime=T+1ms)
    });

    const result = await collect(
      createFetchService(BASE_URL).getRows(mkTable(), { startTime: T }),
    );

    // The 501 rows of the stalled batch are committed exactly once — no infinite loop.
    expect(result).toHaveLength(501);

    // Two batches only: the second re-anchored one millisecond forward (not back to T).
    const calls      = vi.mocked(global.fetch).mock.calls;
    const startTimes = calls.map(c => new URL(String(c[0])).searchParams.get('startTime'));

    expect(calls).toHaveLength(20);
    expect(startTimes.slice(0, 10)).toEqual(Array(10).fill(T));
    expect(startTimes.slice(10)).toEqual(Array(10).fill(TPlus));
  });

  it('re-anchors on the configured tsField (logged), not timestamp', async () => {
    // compositeIndex sorts/filters on `logged`, not `timestamp`. The block re-anchor
    // must use the row's `logged`, so the second batch's startTime is the last logged
    // value (06:00) — never the rows' event timestamp (01:00).
    const S    = '2023-10-23T00:00:00.000Z';
    const L1   = '2023-10-23T06:00:00.000Z';
    const full = Array.from({ length: 500 }, () => ({ timestamp: '2023-10-23T01:00:00.000Z', logged: L1 }));

    const encS = '2023-10-23T00%3A00%3A00.000Z';

    vi.mocked(global.fetch).mockImplementation(async (url) => {
      const u = String(url);

      if (u.includes(`startTime=${encS}`) && u.includes('start=0&')) return okJson(full);

      return okJson([]); // rest of batch 1, then batch 2 at startTime=L1
    });

    await collect(
      createFetchService(BASE_URL).getRows(mkTable({ tsField: 'logged' }), { startTime: S, count: 500 }),
    );

    const startTimes = vi.mocked(global.fetch).mock.calls
      .map(c => new URL(String(c[0])).searchParams.get('startTime'));

    expect(startTimes.slice(0, 10)).toEqual(Array(10).fill(S));
    expect(startTimes.slice(10)).toEqual(Array(10).fill(L1));
  });

  it('returns when an incomplete batch has no timestamp to advance the block to', async () => {
    // Rows with no timestamp/date: cannot advance blockStartTime, so iteration ends.
    vi.mocked(global.fetch).mockImplementation(async (url) =>
      String(url).includes('start=0&') ? okJson([{ id: 1 }]) : okJson([])
    );

    const result = await collect(createFetchService(BASE_URL).getRows(mkTable()));

    expect(result).toEqual([{ id: 1 }]);
    // Single batch, then return — no second batch is attempted.
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(10);
  });
});

// ── getDay ────────────────────────────────────────────────────────────────────

describe('FetchService — getDay', () => {
  beforeEach(() => vi.spyOn(global, 'fetch'));
  afterEach(() => vi.restoreAllMocks());

  it('sets startTime and endTime from the given YYYYMMDD date', async () => {
    vi.mocked(global.fetch).mockResolvedValue(okJson([]));

    await collect(createFetchService(BASE_URL).getDay(mkTable(), '20200101'));

    const url = vi.mocked(global.fetch).mock.calls[0]![0] as string;
    expect(url).toContain('startTime=2020-01-01T00%3A00%3A00.000Z');
    expect(url).toContain('endTime=2020-01-03T00%3A00%3A00.000Z');
  });

  it('yields rows from the API for that day', async () => {
    const rows = [{ timestamp: '2020-01-01T12:00:00.000Z', price: 7000 }];

    // Return rows only on the first-page, original-startTime fetch. Any post-transition
    // fetch (with startTime set to the row's own timestamp) returns empty so the
    // iterator terminates rather than looping on the same row.
    vi.mocked(global.fetch).mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('startTime=2020-01-01T00%3A00%3A00.000Z') && u.includes('start=0&'))
        return okJson(rows);

      return okJson([]);
    });

    const result = await collect(createFetchService(BASE_URL).getDay(mkTable(), '20200101'));

    expect(result).toEqual(rows);
  });
});
