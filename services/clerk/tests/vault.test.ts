import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { listTables, listFiles, readFileGroups } from '../src/vault';
import { isWsMessage, type WsMessage } from '../src/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a mock fetch Response whose body streams NDJSON lines.
 * Honors `?skip=N` in the URL the same way vault does — server-side slice —
 * so tests reflect the real contract: clerk receives only the un-skipped tail.
 */
const ndjsonResponse = (
  items:  (WsMessage | Record<string, unknown>)[],
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
const stubNdjsonFetch = (items: (WsMessage | Record<string, unknown>)[]): void => {
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

// ── readFileGroups — WS format ────────────────────────────────────────────────

describe('readFileGroups — WS file', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits each WsMessage line as one group', async () => {
    const groups: WsMessage[] = [
      { action: 'partial', date: '2024-01-01T00:00:00.000Z', data: [{ symbol: 'XBTUSD', price: 100 }, { symbol: 'ETHUSD', price: 200 }] },
      { action: 'insert',  date: '2024-01-01T01:00:00.000Z', data: [{ symbol: 'XBTUSD', price: 101 }] },
    ];

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse(groups)));

    const captured: Array<{ msg: WsMessage; index: number }> = [];

    const count = await readFileGroups('http://vault', 'trade', '20240101', async (r, index) => {
      captured.push({ msg: r as WsMessage, index });
    });

    expect(count).toBe(2);
    expect(captured).toHaveLength(2);

    // First group: two rows
    expect(isWsMessage(captured[0]!.msg)).toBe(true);
    expect(captured[0]!.msg.data).toHaveLength(2);
    expect(captured[0]!.msg.data[0]!['symbol']).toBe('XBTUSD');
    expect(captured[0]!.msg.data[1]!['symbol']).toBe('ETHUSD');
    expect(captured[0]!.index).toBe(0);

    // Second group: one row
    expect(captured[1]!.msg.data).toHaveLength(1);
    expect(captured[1]!.msg.data[0]!['symbol']).toBe('XBTUSD');
    expect(captured[1]!.index).toBe(1);
  });

  it('passes through numeric and string fields in data rows as-is', async () => {
    const groups: WsMessage[] = [
      { action: 'insert', date: '2024-01-01T00:00:00.000Z', data: [{ price: 29500, symbol: 'XBTUSD' }] },
    ];

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse(groups)));

    const captured: WsMessage[] = [];
    await readFileGroups('http://vault', 'trade', '20240101', async (r) => {
      captured.push(r as WsMessage);
    });

    expect(captured[0]!.data[0]!['price']).toBe(29500);
    expect(captured[0]!.data[0]!['symbol']).toBe('XBTUSD');
  });

  it('handles a WsMessage with multiple data rows', async () => {
    const groups: WsMessage[] = [
      { action: 'insert', date: '2024-01-01T00:00:00.000Z', data: [{ symbol: 'XBTUSD' }, { symbol: 'ETHUSD' }] },
    ];

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse(groups)));

    const captured: WsMessage[] = [];
    await readFileGroups('http://vault', 'trade', '20240101', async (r) => {
      captured.push(r as WsMessage);
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.data).toHaveLength(2);
  });

  it('isWsMessage returns true for WS lines and false for plain rows', async () => {
    const wsMsg: WsMessage = { action: 'insert', date: '2024-01-01T00:00:00.000Z', data: [] };
    const restRow = { symbol: 'XBTUSD', fundingRate: 0.0001 };

    expect(isWsMessage(wsMsg)).toBe(true);
    expect(isWsMessage(restRow)).toBe(false);
    expect(isWsMessage(null)).toBe(false);
    expect(isWsMessage([])).toBe(false);
  });
});

// ── readFileGroups — REST format ──────────────────────────────────────────────

describe('readFileGroups — REST file', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits one group per row (no _head_ field)', async () => {
    const rows = [
      { symbol: 'XBTUSD', fundingRate: 0.0001, timestamp: '2024-01-01T00:00:00Z' },
      { symbol: 'ETHUSD', fundingRate: 0.0002, timestamp: '2024-01-01T00:00:00Z' },
    ];

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse(rows)));

    const groups: Array<{ rows: Record<string, unknown>; index: number }> = [];

    const count = await readFileGroups('http://vault', 'funding', '20240101', async (r, index) => {
      groups.push({ rows: r as Record<string, unknown>, index });
    });

    expect(count).toBe(2);
    expect(groups[0]!.rows['symbol']).toBe('XBTUSD');
    expect(groups[0]!.index).toBe(0);
    expect(groups[1]!.rows['symbol']).toBe('ETHUSD');
    expect(groups[1]!.index).toBe(1);
  });

  it('returns 0 for an empty file', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse([])));

    const groups: unknown[] = [];
    const count = await readFileGroups('http://vault', 'funding', '20240101', async (r) => {
      groups.push(r);
    });

    expect(count).toBe(0);
    expect(groups).toHaveLength(0);
  });
});

// ── readFileGroups — nested values ───────────────────────────────────────────

describe('readFileGroups — nested values', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes through nested objects as-is', async () => {
    const rows = [{ symbol: 'XBTUSD', meta: { key: 'val' } }];

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse(rows)));

    const captured: Array<Record<string, unknown>> = [];
    await readFileGroups('http://vault', 'chat', '20240101', async (r) => {
      captured.push(r as Record<string, unknown>);
    });

    expect(captured[0]!['meta']).toEqual({ key: 'val' });
  });

  it('passes through arrays as-is', async () => {
    const rows = [{ symbol: 'XBTUSD', tags: ['a', 'b'] }];

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse(rows)));

    const captured: Array<Record<string, unknown>> = [];
    await readFileGroups('http://vault', 'chat', '20240101', async (r) => {
      captured.push(r as Record<string, unknown>);
    });

    expect(captured[0]!['tags']).toEqual(['a', 'b']);
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

  it('passes ?skip=startFrom to vault and emits absolute msgIndex for WS files', async () => {
    const groups: WsMessage[] = [
      { action: 'insert', date: '2024-01-01T00:00:00.000Z', data: [{ symbol: 'XBTUSD' }] },
      { action: 'insert', date: '2024-01-01T01:00:00.000Z', data: [{ symbol: 'ETHUSD' }] },
      { action: 'insert', date: '2024-01-01T02:00:00.000Z', data: [{ symbol: 'SOLUSDT' }] },
    ];

    stubNdjsonFetch(groups);

    const captured: Array<{ msg: WsMessage; index: number }> = [];

    const count = await readFileGroups('http://vault', 'trade', '20240101', async (r, index) => {
      captured.push({ msg: r as WsMessage, index });
    }, 1);

    // Vault sliced 1 row → clerk receives 2, total reported is startFrom + received
    expect(count).toBe(3);
    expect(captured).toHaveLength(2);
    expect(captured[0]!.index).toBe(1);
    expect(captured[1]!.index).toBe(2);

    expect(fetch).toHaveBeenCalledWith('http://vault/files/trade/20240101?skip=1', expect.objectContaining({ signal: expect.any(Object) }));
  });

  it('passes ?skip=startFrom to vault and emits absolute msgIndex for REST files', async () => {
    const rows = [
      { symbol: 'XBTUSD', price: 100 },
      { symbol: 'ETHUSD', price: 200 },
      { symbol: 'SOLUSDT', price: 300 },
    ];

    stubNdjsonFetch(rows);

    const groups: Array<{ rows: unknown[]; index: number }> = [];

    const count = await readFileGroups('http://vault', 'funding', '20240101', async (r, index) => {
      groups.push({ rows: r, index });
    }, 2);

    expect(count).toBe(3);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.index).toBe(2);

    expect(fetch).toHaveBeenCalledWith('http://vault/files/funding/20240101?skip=2', expect.objectContaining({ signal: expect.any(Object) }));
  });

  it('omits the ?skip= query when startFrom is 0 (default)', async () => {
    const rows = [
      { symbol: 'XBTUSD', price: 100 },
      { symbol: 'ETHUSD', price: 200 },
    ];

    stubNdjsonFetch(rows);

    const indices: number[] = [];
    await readFileGroups('http://vault', 'funding', '20240101', async (_, index) => {
      indices.push(index);
    });

    expect(indices).toEqual([0, 1]);
    expect(fetch).toHaveBeenCalledWith('http://vault/files/funding/20240101', expect.objectContaining({ signal: expect.any(Object) }));
  });

  it('calls onGroup for nothing when startFrom equals total groups', async () => {
    const rows = [
      { symbol: 'XBTUSD', price: 100 },
    ];

    stubNdjsonFetch(rows);

    const called: unknown[] = [];
    const count = await readFileGroups('http://vault', 'funding', '20240101', async (r) => {
      called.push(r);
    }, 1);

    expect(count).toBe(1);
    expect(called).toHaveLength(0);
  });
});
