import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { listTables, listFiles, readFileGroups } from '../src/vault';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a mock fetch Response whose body streams NDJSON lines.
 * Honors `?skip=N` in the URL the same way vault does — server-side slice —
 * so tests reflect the real contract: clerk receives only the un-skipped tail.
 */
const ndjsonResponse = (
  items:  Record<string, unknown>[],
  status: number = 200,
  url:    string = '',
) => {
  const skip   = url ? Number(new URL(url, 'http://x').searchParams.get('skip')) || 0 : 0;
  const sliced = items.slice(skip);
  const body   = sliced.length
    ? sliced.map(i => JSON.stringify(i)).join('\n') + '\n'
    : '';

  return {
    ok:     status >= 200 && status < 300,
    status,
    json:   () => Promise.resolve({}),
    body:   Readable.toWeb(Readable.from([body])),
  };
};

/** Stub fetch with a handler that slices items based on the URL's ?skip= query. */
const stubNdjsonFetch = (items: Record<string, unknown>[]): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => Promise.resolve(ndjsonResponse(items, 200, url))),
  );
};

/** Create a mock JSON response (for listFiles). */
const jsonResponse = (data: unknown, status = 200) => ({
  ok:     status >= 200 && status < 300,
  status,
  json:   () => Promise.resolve(data),
});

// ── listTables ───────────────────────────────────────────────────────────────

describe('listTables', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the array of table names on 200', async () => {
    const tables = ['trade', 'quote', 'instrument'];
    vi.mocked(fetch).mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve(tables),
    } as Response);

    const result = await listTables('http://vault');

    expect(result).toEqual(tables);
    expect(fetch).toHaveBeenCalledWith('http://vault/tables');
  });

  it('retries on a non-ok response and resolves once vault recovers', async () => {
    const tables = ['trade'];

    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 503, json: vi.fn() } as unknown as Response)
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(tables) } as unknown as Response);

    vi.useFakeTimers();

    const result = listTables('http://vault');

    // Advance past the retry delay to trigger the second attempt
    await vi.advanceTimersByTimeAsync(6_000);
    vi.useRealTimers();

    await expect(result).resolves.toEqual(tables);
  });
});

// ── listFiles ─────────────────────────────────────────────────────────────────

describe('listFiles', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the parsed file map on 200', async () => {
    const files = { '20240101': 'closed', '20240102': 'open' };
    vi.mocked(fetch).mockResolvedValue(jsonResponse(files) as Response);

    const result = await listFiles('http://vault', 'trade');

    expect(result).toEqual(files);
    expect(fetch).toHaveBeenCalledWith('http://vault/files/trade');
  });

  it('returns null on 404 (table not found)', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(null, 404) as Response);

    const result = await listFiles('http://vault', 'unknown_table');

    expect(result).toBeNull();
  });
});

// ── readFileGroups — line passthrough ─────────────────────────────────────────

describe('readFileGroups — passthrough', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits each NDJSON line as one group, as a raw string', async () => {
    const items = [
      { action: 'partial', date: '2024-01-01T00:00:00.000Z', data: [{ symbol: 'XBTUSD' }] },
      { action: 'insert',  date: '2024-01-01T01:00:00.000Z', data: [{ symbol: 'ETHUSD' }] },
    ];

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse(items)));

    const captured: Array<{ line: string; index: number }> = [];

    const count = await readFileGroups('http://vault', 'orderBookL2', '20240101', async (line, index) => {
      captured.push({ line, index });
    });

    expect(count).toBe(2);
    expect(captured).toHaveLength(2);
    expect(captured[0]!.line).toBe(JSON.stringify(items[0]));
    expect(captured[0]!.index).toBe(0);
    expect(captured[1]!.line).toBe(JSON.stringify(items[1]));
    expect(captured[1]!.index).toBe(1);
  });

  it('does not parse — lines are handed off verbatim', async () => {
    const items = [{ price: 29500, symbol: 'XBTUSD', nested: { a: 1 }, tags: ['x', 'y'] }];

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse(items)));

    const captured: string[] = [];
    await readFileGroups('http://vault', 'trade', '20240101', async (line) => {
      captured.push(line);
    });

    expect(captured[0]).toBe(JSON.stringify(items[0]));
    expect(typeof captured[0]).toBe('string');
  });

  it('returns 0 for an empty file', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse([])));

    const captured: string[] = [];
    const count = await readFileGroups('http://vault', 'funding', '20240101', async (line) => {
      captured.push(line);
    });

    expect(count).toBe(0);
    expect(captured).toHaveLength(0);
  });
});

// ── readFileGroups — HTTP errors ──────────────────────────────────────────────

describe('readFileGroups — HTTP errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, body: null }));

    await expect(
      readFileGroups('http://vault', 'trade', '20240101', async () => {}),
    ).rejects.toThrow('HTTP 500');
  });
});

// ── readFileGroups — startFrom ────────────────────────────────────────────────

describe('readFileGroups — startFrom', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes ?skip=startFrom to vault and emits absolute msgIndex', async () => {
    const items = [
      { symbol: 'XBTUSD',  price: 100 },
      { symbol: 'ETHUSD',  price: 200 },
      { symbol: 'SOLUSDT', price: 300 },
    ];

    stubNdjsonFetch(items);

    const captured: Array<{ line: string; index: number }> = [];

    const count = await readFileGroups('http://vault', 'trade', '20240101', async (line, index) => {
      captured.push({ line, index });
    }, 1);

    // Vault sliced 1 row → clerk receives 2, total reported is startFrom + received
    expect(count).toBe(3);
    expect(captured).toHaveLength(2);
    expect(captured[0]!.index).toBe(1);
    expect(captured[1]!.index).toBe(2);
    expect(captured[0]!.line).toBe(JSON.stringify(items[1]));

    expect(fetch).toHaveBeenCalledWith('http://vault/files/trade/20240101?skip=1', expect.objectContaining({ signal: expect.any(Object) }));
  });

  it('omits the ?skip= query when startFrom is 0 (default)', async () => {
    const items = [
      { symbol: 'XBTUSD', price: 100 },
      { symbol: 'ETHUSD', price: 200 },
    ];

    stubNdjsonFetch(items);

    const indices: number[] = [];
    await readFileGroups('http://vault', 'funding', '20240101', async (_line, index) => {
      indices.push(index);
    });

    expect(indices).toEqual([0, 1]);
    expect(fetch).toHaveBeenCalledWith('http://vault/files/funding/20240101', expect.objectContaining({ signal: expect.any(Object) }));
  });

  it('calls onGroup for nothing when startFrom equals total groups', async () => {
    const items = [
      { symbol: 'XBTUSD', price: 100 },
    ];

    stubNdjsonFetch(items);

    const called: string[] = [];
    const count = await readFileGroups('http://vault', 'funding', '20240101', async (line) => {
      called.push(line);
    }, 1);

    expect(count).toBe(1);
    expect(called).toHaveLength(0);
  });
});
