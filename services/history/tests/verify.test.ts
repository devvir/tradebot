// Pending Review
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifyFirstTimestamps } from '../src/persistence/index.js';
import type { HistoryState } from '../src/persistence/index.js';

const BASE_URL = 'https://www.bitmex.com/api/v1';

const makeState = (id: string, firstTimestamp: string | null): HistoryState => ({
  _id: id,
  start: 100,
  lastFetchedAt: new Date(),
  totalFetched: 100,
  firstTimestamp,
});

const okJson = (data: unknown): Response =>
  ({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(data) } as unknown as Response);

describe('verifyFirstTimestamps', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes without throwing when all firstTimestamps match', async () => {
    // 'trade' table has no symbolSource, so its state key is 'trade'
    const states = new Map([
      ['trade', makeState('trade', '2020-01-01T00:00:00.000Z')],
    ]);

    vi.mocked(global.fetch).mockResolvedValue(
      okJson([{ trdMatchID: 'abc', timestamp: '2020-01-01T00:00:00.000Z' }])
    );

    await expect(verifyFirstTimestamps({ baseUrl: BASE_URL, states })).resolves.not.toThrow();
  });

  it('throws when a firstTimestamp does not match current API data', async () => {
    const states = new Map([
      ['trade', makeState('trade', '2020-01-01T00:00:00.000Z')],
    ]);

    // API now returns a different first record (data was pruned)
    vi.mocked(global.fetch).mockResolvedValue(
      okJson([{ trdMatchID: 'abc', timestamp: '2021-06-01T00:00:00.000Z' }])
    );

    await expect(verifyFirstTimestamps({ baseUrl: BASE_URL, states })).rejects.toThrow(
      'pagination offset drift'
    );
  });

  it('includes the sub-table id and both timestamps in the error message', async () => {
    const states = new Map([
      ['trade', makeState('trade', '2020-01-01T00:00:00.000Z')],
    ]);

    vi.mocked(global.fetch).mockResolvedValue(
      okJson([{ trdMatchID: 'abc', timestamp: '2022-01-01T00:00:00.000Z' }])
    );

    const error = await verifyFirstTimestamps({ baseUrl: BASE_URL, states }).catch((e) => e);
    expect(error.message).toContain('trade');
    expect(error.message).toContain('2020-01-01T00:00:00.000Z');
    expect(error.message).toContain('2022-01-01T00:00:00.000Z');
  });

  it('skips sub-tables with firstTimestamp = null (not yet fetched)', async () => {
    const states = new Map([
      ['trade', makeState('trade', null)],
    ]);

    await expect(verifyFirstTimestamps({ baseUrl: BASE_URL, states })).resolves.not.toThrow();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('skips sub-tables when the API returns an empty result', async () => {
    const states = new Map([
      ['trade', makeState('trade', '2020-01-01T00:00:00.000Z')],
    ]);

    vi.mocked(global.fetch).mockResolvedValue(okJson([]));

    // An empty or missing API response should be skipped, not treated as a failure
    await expect(verifyFirstTimestamps({ baseUrl: BASE_URL, states })).resolves.not.toThrow();
  });

  it('handles symbol-scoped sub-tables (e.g. "quote:XBTUSD")', async () => {
    const states = new Map([
      ['quote:XBTUSD', makeState('quote:XBTUSD', '2020-01-01T00:00:00.000Z')],
    ]);

    vi.mocked(global.fetch).mockResolvedValue(
      okJson([{ timestamp: '2020-01-01T00:00:00.000Z', symbol: 'XBTUSD' }])
    );

    await expect(verifyFirstTimestamps({ baseUrl: BASE_URL, states })).resolves.not.toThrow();
  });

  it('reports all mismatches in a single error, not just the first', async () => {
    const states = new Map([
      ['trade', makeState('trade', '2020-01-01T00:00:00.000Z')],
      ['funding', makeState('funding', '2019-01-01T00:00:00.000Z')],
    ]);

    vi.mocked(global.fetch).mockResolvedValue(
      okJson([{ timestamp: '2023-01-01T00:00:00.000Z' }])
    );

    const error = await verifyFirstTimestamps({ baseUrl: BASE_URL, states }).catch((e) => e);
    expect(error.message).toContain('trade');
    expect(error.message).toContain('funding');
  });
});
