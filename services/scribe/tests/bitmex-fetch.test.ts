import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFetchService } from '../src/bitmex';
import { _test_MAX_IN_FLIGHT as MAX_IN_FLIGHT } from '../src/bitmex/rows';
import type { TableConfig } from '../src/types';

vi.mock('../src/utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/utils')>(),
  sleep: vi.fn().mockResolvedValue(undefined),
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
// rowIterator streams pages through a bounded ring (up to MAX_IN_FLIGHT in flight,
// flushed in strict offset order). A short/empty page or the maxStart offset cap
// ends a window; blockStartTime then reanchors to the last seen row's tsField and
// a fresh window opens at start=0. The ring fires a little look-ahead, so these
// tests assert the rows and the reanchor points, not exact request counts.

describe('FetchService — getRows', () => {
  beforeEach(() => vi.spyOn(global, 'fetch'));
  afterEach(() => vi.restoreAllMocks());

  it('yields rows from a partial first page in the batch', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    vi.mocked(global.fetch).mockResolvedValue(okJson(rows));

    const result = await collect(createFetchService(BASE_URL).getRows(mkTable()));

    expect(result).toEqual(rows);

    // MAX_IN_FLIGHT fetches issued in the batch; partial first page stops yielding after it.
    // No timestamp on the rows → cannot advance block → returns.
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(MAX_IN_FLIGHT);
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
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(MAX_IN_FLIGHT);
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

  it('issues MAX_IN_FLIGHT parallel fetches at offsets [start, start+page, …]', async () => {
    vi.mocked(global.fetch).mockResolvedValue(okJson([]));

    await collect(createFetchService(BASE_URL).getRows(mkTable()));

    const calls  = vi.mocked(global.fetch).mock.calls;
    const starts = calls.map(c => new URL(String(c[0])).searchParams.get('start'));

    expect(starts).toEqual(Array.from({ length: MAX_IN_FLIGHT }, (_, i) => String(i * 500)));
  });

  it('reanchors at the maxStart offset cap and never launches past it', async () => {
    const PAGE      = 500;
    const maxStart  = 4999;
    const pages     = Math.floor(maxStart / PAGE) + 1; // pages that fit under the cap (independent of ring size)
    const timestamp = '2020-01-01T00:00:00.000Z';
    const fullPage  = Array.from({ length: PAGE }, () => ({ timestamp }));

    // Unanchored window returns full pages (until the cap); the reanchored window is empty → end.
    vi.mocked(global.fetch).mockImplementation(async (url) =>
      String(url).includes('startTime=') ? okJson([]) : okJson(fullPage)
    );

    const result = await collect(createFetchService(BASE_URL).getRows(mkTable({ maxStart })));

    // Exactly the pages that fit under maxStart, then a reanchored (empty) window.
    expect(result).toHaveLength(PAGE * pages);

    const params = vi.mocked(global.fetch).mock.calls.map(c => new URL(String(c[0])).searchParams);

    // No fetch is ever launched past the cap.
    expect(params.every(p => Number(p.get('start')) <= maxStart)).toBe(true);

    // First window opens unanchored; the second reanchored to the row timestamp at start=0.
    expect(params[0]!.get('startTime')).toBeNull();
    expect(params.some(p => p.get('startTime') === timestamp && p.get('start') === '0')).toBe(true);
  });

  it('reanchors mid-window when data ends before the offset cap (bug bypass)', async () => {
    const timestamp = '2020-01-01T00:00:00.000Z';
    const fullPage  = Array.from({ length: 500 }, () => ({ timestamp }));

    // start=0 (no startTime) is full; everything past it is empty — BitMEX's
    // undocumented mid-window cap. With a timestamp present the window reanchors to
    // it and a fresh window opens at start=0, even though maxStart was never reached.
    vi.mocked(global.fetch).mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('startTime=')) return okJson([]);
      if (u.includes('start=0&'))   return okJson(fullPage);
      return okJson([]);
    });

    const result = await collect(createFetchService(BASE_URL).getRows(mkTable()));

    expect(result).toHaveLength(500);

    const params = vi.mocked(global.fetch).mock.calls.map(c => new URL(String(c[0])).searchParams);

    // First window unanchored; the second reanchored to the row timestamp at start=0.
    expect(params[0]!.get('startTime')).toBeNull();
    expect(params.some(p => p.get('startTime') === timestamp && p.get('start') === '0')).toBe(true);
  });

  it('force-advances startTime by 1ms when a window ends on its own anchor (no progress)', async () => {
    // Backfilled island (e.g. .BUSDP 2023-10-23): querying startTime=T returns a full
    // page then a short page both ending at T, so lastTs === blockStartTime. Reanchoring
    // to T would refetch the identical window forever; the guard steps the anchor +1ms.
    const T     = '2023-10-23T05:47:40.000Z';
    const TPlus = '2023-10-23T05:47:40.001Z';
    const full  = Array.from({ length: 500 }, () => ({ timestamp: T }));

    const encT = '2023-10-23T05%3A47%3A40.000Z';

    vi.mocked(global.fetch).mockImplementation(async (url) => {
      const u = String(url);

      if (u.includes(`startTime=${encT}`) && u.includes('start=0&'))   return okJson(full);
      if (u.includes(`startTime=${encT}`) && u.includes('start=500&')) return okJson([{ timestamp: T }]);

      return okJson([]);
    });

    const result = await collect(
      createFetchService(BASE_URL).getRows(mkTable(), { startTime: T }),
    );

    // The 501 rows are committed exactly once — no infinite loop.
    expect(result).toHaveLength(501);

    const params = vi.mocked(global.fetch).mock.calls.map(c => new URL(String(c[0])).searchParams);

    // The next window force-advanced to T+1ms; it never re-anchored back to T.
    expect(params.some(p => p.get('startTime') === T     && p.get('start') === '0')).toBe(true);
    expect(params.some(p => p.get('startTime') === TPlus && p.get('start') === '0')).toBe(true);
  });

  it('re-anchors on the configured tsField (logged), not timestamp', async () => {
    // compositeIndex sorts/filters on `logged`, not `timestamp`. The reanchor must use
    // the row's `logged` (06:00) — never the event timestamp (01:00).
    const S    = '2023-10-23T00:00:00.000Z';
    const L1   = '2023-10-23T06:00:00.000Z';
    const TS   = '2023-10-23T01:00:00.000Z';
    const full = Array.from({ length: 500 }, () => ({ timestamp: TS, logged: L1 }));

    const encS = '2023-10-23T00%3A00%3A00.000Z';

    vi.mocked(global.fetch).mockImplementation(async (url) => {
      const u = String(url);

      if (u.includes(`startTime=${encS}`) && u.includes('start=0&')) return okJson(full);

      return okJson([]);
    });

    await collect(
      createFetchService(BASE_URL).getRows(mkTable({ tsField: 'logged' }), { startTime: S, count: 500 }),
    );

    const params = vi.mocked(global.fetch).mock.calls.map(c => new URL(String(c[0])).searchParams);

    expect(params.some(p => p.get('startTime') === S  && p.get('start') === '0')).toBe(true);
    expect(params.some(p => p.get('startTime') === L1 && p.get('start') === '0')).toBe(true);
    expect(params.some(p => p.get('startTime') === TS)).toBe(false); // never the event timestamp
  });

  it('returns when an incomplete batch has no timestamp to advance the block to', async () => {
    // Rows with no timestamp/date: cannot advance blockStartTime, so iteration ends.
    vi.mocked(global.fetch).mockImplementation(async (url) =>
      String(url).includes('start=0&') ? okJson([{ id: 1 }]) : okJson([])
    );

    const result = await collect(createFetchService(BASE_URL).getRows(mkTable()));

    expect(result).toEqual([{ id: 1 }]);
    // Single batch, then return — no second batch is attempted.
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(MAX_IN_FLIGHT);
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
