import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchSymbols } from '../src/utils/symbols.js';

const BASE_URL = 'https://www.bitmex.com/api/v1';

const makeResponse = (data: unknown, ok = true, status = 200): Response => {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
  } as unknown as Response;
};

describe('fetchSymbols', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('separates instruments from index symbols (starting with ".")', async () => {
    const instruments = [
      { symbol: 'XBTUSD', state: 'Open' },
      { symbol: '.BXBT', state: 'Settled' },
      { symbol: '.BETHXBT', state: 'Open' },
      { symbol: 'ETHUSD', state: 'Open' },
    ];
    vi.mocked(global.fetch).mockResolvedValueOnce(makeResponse(instruments));

    const result = await fetchSymbols(BASE_URL);

    expect(result.instruments).toEqual(['XBTUSD', 'ETHUSD']);
    expect(result.indices).toEqual(['.BXBT', '.BETHXBT']);
  });

  it('includes Unlisted instruments', async () => {
    const instruments = [
      { symbol: 'XBTUSD', state: 'Open' },
      { symbol: 'OLDINSTR', state: 'Unlisted' },
      { symbol: 'ETHUSD', state: 'Closed' },
    ];
    vi.mocked(global.fetch).mockResolvedValueOnce(makeResponse(instruments));

    const result = await fetchSymbols(BASE_URL);

    // With current code: Unlisted are filtered out → fails
    // With fix:          all symbols included regardless of state
    expect(result.instruments).toEqual(['XBTUSD', 'OLDINSTR', 'ETHUSD']);
  });

  it('does not include index symbols in the instruments list', async () => {
    const instruments = [
      { symbol: '.BXBT', state: 'Open' },
      { symbol: 'XBTUSD', state: 'Open' },
    ];
    vi.mocked(global.fetch).mockResolvedValueOnce(makeResponse(instruments));

    const result = await fetchSymbols(BASE_URL);

    expect(result.instruments).not.toContain('.BXBT');
    expect(result.indices).toContain('.BXBT');
  });

  it('includes Unlisted-only symbols in the result', async () => {
    const instruments = [
      { symbol: 'OLD1', state: 'Unlisted' },
      { symbol: 'OLD2', state: 'Unlisted' },
    ];
    vi.mocked(global.fetch).mockResolvedValueOnce(makeResponse(instruments));

    const result = await fetchSymbols(BASE_URL);

    // With current code: all Unlisted → empty arrays → fails
    // With fix:          Unlisted symbols included
    expect(result.instruments).toEqual(['OLD1', 'OLD2']);
  });

  it('reports inactive (non-Open) symbols in a separate set', async () => {
    const instruments = [
      { symbol: 'XBTUSD', state: 'Open' },
      { symbol: 'OLDINSTR', state: 'Unlisted' },
      { symbol: 'SETTLEDINSTR', state: 'Settled' },
      { symbol: '.BXBT', state: 'Open' },
      { symbol: '.OLDIDX', state: 'Unlisted' },
    ];
    vi.mocked(global.fetch).mockResolvedValueOnce(makeResponse(instruments));

    const result = await fetchSymbols(BASE_URL);

    expect(result.inactive).toBeInstanceOf(Set);
    expect(result.inactive).toContain('OLDINSTR');
    expect(result.inactive).toContain('SETTLEDINSTR');
    expect(result.inactive).toContain('.OLDIDX');
    expect(result.inactive).not.toContain('XBTUSD');
    expect(result.inactive).not.toContain('.BXBT');
  });

  it('throws when the HTTP response is not ok', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(makeResponse(null, false, 503));

    await expect(fetchSymbols(BASE_URL)).rejects.toThrow('HTTP 503');
  });

  it('calls the correct endpoint URL', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(makeResponse([]));

    await fetchSymbols(BASE_URL);

    expect(global.fetch).toHaveBeenCalledWith(
      `${BASE_URL}/instrument?count=1000&start=0&columns=symbol,state&reverse=false`
    );
  });

  it('paginates until a partial page is returned', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ symbol: `SYM${i}`, state: 'Open' }));
    const page2 = [{ symbol: 'LAST', state: 'Open' }];

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(makeResponse(page1))
      .mockResolvedValueOnce(makeResponse(page2));

    const result = await fetchSymbols(BASE_URL);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenNthCalledWith(2, `${BASE_URL}/instrument?count=1000&start=1000&columns=symbol,state&reverse=false`);
    expect(result.instruments).toHaveLength(1001);
    expect(result.instruments).toContain('LAST');
  });
});
