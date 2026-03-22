// Pending Review
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchPage, fetchFirstTimestamp } from '../src/fetcher.js';

const BASE_URL = 'https://www.bitmex.com/api/v1';

const okJson = (data: unknown): Response =>
  ({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(data) } as unknown as Response);

// ── fetchPage ─────────────────────────────────────────────────────────────────

describe('fetchPage', () => {
  beforeEach(() => { vi.spyOn(global, 'fetch'); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns rows from the API', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    vi.mocked(global.fetch).mockResolvedValueOnce(okJson(rows));

    const result = await fetchPage({ baseUrl: BASE_URL, path: '/chat', symbol: null, start: 0 });

    expect(result).toEqual(rows);
  });

  it('builds URL with start, count, reverse, and no symbol', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(okJson([]));

    await fetchPage({ baseUrl: BASE_URL, path: '/chat', symbol: null, start: 100 });

    const url = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(url).toContain('/chat?');
    expect(url).toContain('start=100');
    expect(url).toContain('count=500');
    expect(url).toContain('reverse=false');
    expect(url).not.toContain('symbol=');
    expect(url).not.toContain('startTime=');
  });

  it('includes symbol when provided', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(okJson([]));

    await fetchPage({ baseUrl: BASE_URL, path: '/trade', symbol: 'XBTUSD', start: 0 });

    const url = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(url).toContain('symbol=XBTUSD');
  });

  it('includes startTime when provided', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(okJson([]));

    await fetchPage({ baseUrl: BASE_URL, path: '/trade', symbol: null, start: 0, startTime: '2020-01-01T00:00:00.000Z' });

    const url = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(url).toContain('startTime=2020-01-01');
  });

  it('retries on 429 then returns successful response', async () => {
    vi.useFakeTimers();

    const response429 = { ok: false, status: 429, headers: new Headers(), json: () => Promise.resolve([]) } as unknown as Response;
    const rows = [{ id: 1 }];

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(response429)
      .mockResolvedValueOnce(okJson(rows));

    const fetchPromise = fetchPage({ baseUrl: BASE_URL, path: '/chat', symbol: null, start: 0 });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await fetchPromise;

    vi.useRealTimers();

    expect(result).toEqual(rows);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

// ── fetchFirstTimestamp ─────────────────────────────────────────────────────────

describe('fetchFirstTimestamp', () => {
  beforeEach(() => { vi.spyOn(global, 'fetch'); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns timestamp from first row', async () => {
    const rows = [{ id: 1, timestamp: '2019-01-01T00:00:00.000Z', text: 'oldest' }];
    vi.mocked(global.fetch).mockResolvedValueOnce(okJson(rows));

    const result = await fetchFirstTimestamp(BASE_URL, '/chat', null);

    expect(result).toBe('2019-01-01T00:00:00.000Z');
  });

  it('falls back to date field when no timestamp', async () => {
    const rows = [{ id: 1, date: '2019-06-01' }];
    vi.mocked(global.fetch).mockResolvedValueOnce(okJson(rows));

    const result = await fetchFirstTimestamp(BASE_URL, '/insurance', null);

    expect(result).toBe('2019-06-01');
  });

  it('returns null on empty result', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(okJson([]));

    const result = await fetchFirstTimestamp(BASE_URL, '/chat', null);

    expect(result).toBeNull();
  });

  it('requests count=1 with start=0', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(okJson([]));

    await fetchFirstTimestamp(BASE_URL, '/chat', 'XBTUSD');

    const url = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(url).toContain('count=1');
    expect(url).toContain('start=0');
    expect(url).toContain('symbol=XBTUSD');
  });
});
