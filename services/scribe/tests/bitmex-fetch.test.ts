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

describe('FetchService — getRows', () => {
  beforeEach(() => vi.spyOn(global, 'fetch'));
  afterEach(() => vi.restoreAllMocks());

  it('yields all rows from a single partial page', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    vi.mocked(global.fetch).mockResolvedValue(okJson(rows));

    const result = await collect(createFetchService(BASE_URL).getRows(mkTable()));

    expect(result).toEqual(rows);
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
  });

  it('paginates through multiple pages, advancing start offset', async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => ({ id: i }));
    const page2 = [{ id: 500 }];

    vi.mocked(global.fetch).mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('start=0&')) return okJson(page1);
      return okJson(page2);
    });

    const result = await collect(createFetchService(BASE_URL).getRows(mkTable()));

    expect(result).toHaveLength(501);
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(2);

    const secondUrl = vi.mocked(global.fetch).mock.calls[1]![0] as string;
    expect(secondUrl).toContain('start=500');
  });

  it('stops immediately on an empty first page', async () => {
    vi.mocked(global.fetch).mockResolvedValue(okJson([]));

    const result = await collect(createFetchService(BASE_URL).getRows(mkTable()));

    expect(result).toHaveLength(0);
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
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

  it('performs a block transition when start exceeds maxStart − 1000', async () => {
    const timestamp = '2020-01-01T00:00:00.000Z';
    // maxStart=999 → threshold=499. After a full page (start=500 > 499), transition fires.
    const fullPage  = Array.from({ length: 500 }, () => ({ timestamp }));

    // First call: no startTime param → return full page to trigger transition.
    // Second call: has startTime (block transition happened) → return empty to stop.
    vi.mocked(global.fetch).mockImplementation(async (url) => {
      return String(url).includes('startTime=') ? okJson([]) : okJson(fullPage);
    });

    const result = await collect(createFetchService(BASE_URL).getRows(mkTable({ maxStart: 999 })));

    expect(result).toHaveLength(500);
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(2);

    const secondUrl = vi.mocked(global.fetch).mock.calls[1]![0] as string;
    expect(secondUrl).toContain('start=0');
    expect(secondUrl).toContain('startTime=');
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
    vi.mocked(global.fetch).mockResolvedValue(okJson(rows));

    const result = await collect(createFetchService(BASE_URL).getDay(mkTable(), '20200101'));

    expect(result).toEqual(rows);
  });
});
