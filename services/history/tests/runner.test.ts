import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runAllTables } from '../src/runner.js';
import type { TableConfig } from '../src/types.js';
import type { PersistenceService } from '../src/persistence/index.js';

// ── Module mocks ────────────────────────────────────────────────────────────

// Throttling is mocked to make empty-page waits instant.
vi.mock('../src/utils/throttling.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  waitIfNeeded: vi.fn().mockResolvedValue(undefined),
  waitForPartialPage: vi.fn().mockResolvedValue(undefined),
}));

// TABLES is mutable so each test can inject just the table it needs.
vi.mock('../src/utils/tables.js', () => ({
  TABLES: [] as TableConfig[],
  PAGE_SIZE: 500,
}));

import * as tablesModule from '../src/utils/tables.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const INSTRUMENTS_TABLE: TableConfig = {
  name: 'quote',
  path: '/quote',
  auth: false,
  symbolSource: 'instruments',
  idFields: null,
  maxStart: null,
};

const mockService = {
  config: () => ({ bitmexRestUrl: 'https://mock.bitmex.com/api/v1', database: 'test' }),
} as any;

const makePersistence = (): PersistenceService => ({
  loadAllStates: vi.fn().mockResolvedValue(new Map()),
  saveState: vi.fn().mockResolvedValue(undefined),
  bind: vi.fn().mockReturnValue({
    write: vi.fn().mockResolvedValue({ transitioned: false }),
    flush: vi.fn().mockResolvedValue(undefined),
  }),
});

// Returns a response whose .json() throws — causes fetchPage to throw outside of
// fetchWithRetry's try-catch, so the error is not swallowed and retried.
const sentinelResponse = (msg: string): Response => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: () => { throw new Error(msg); },
} as unknown as Response);

const okResponse = (data: unknown): Response => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: () => Promise.resolve(data),
} as unknown as Response);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runner — multi-symbol loop bugs', () => {
  beforeEach(() => {
    (tablesModule.TABLES as TableConfig[]).length = 0;
    vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Bug: when fetchFirstTimestamp returns null for a symbol (no historical data),
  // the runner still enters the page loop and spins on empty pages forever
  // instead of skipping the symbol.
  it('does not enter the page loop when firstTimestamp is null', async () => {
    (tablesModule.TABLES as TableConfig[]).push(INSTRUMENTS_TABLE);

    vi.mocked(global.fetch).mockImplementation(async (url) => {

      if (String(url).includes('count=1')) {
        return okResponse([]); // empty result → fetchFirstTimestamp returns null
      }

      // fetchPage should never be called for a symbol with no historical data
      return sentinelResponse('BUG: fetchPage called for symbol with null firstTimestamp');
    });

    // With current code: enters page loop → sentinel fires → rejects
    // With fix:          symbol is skipped → resolves (no symbols left to fetch)
    await expect(
      runAllTables(mockService, makePersistence(), {
        states: new Map(),
        instruments: ['DEAD'],
        indices: [],
        inactive: new Set(),
      })
    ).resolves.toBeUndefined();
  });

  // Bug: a dead symbol (null firstTimestamp) blocks the sequential loop forever,
  // preventing subsequent symbols from ever being reached.
  it('progresses past dead symbols to reach later ones', async () => {
    (tablesModule.TABLES as TableConfig[]).push(INSTRUMENTS_TABLE);

    const startedSymbols = new Set<string>();

    vi.mocked(global.fetch).mockImplementation(async (url) => {
      const urlStr = String(url);
      const symbol = urlStr.match(/symbol=([^&]+)/)?.[1];

      if (urlStr.includes('count=1')) {
        if (symbol) startedSymbols.add(symbol);

        // DEAD has no data → null firstTimestamp → marked complete → skipped
        if (symbol === 'DEAD') return okResponse([]);

        return okResponse([{ timestamp: '2020-01-01T00:00:00.000Z' }]);
      }

      // ALIVE enters page loop — sentinel stops the test cleanly
      return sentinelResponse('__stop__');
    });

    await expect(
      runAllTables(mockService, makePersistence(), {
        states: new Map(),
        instruments: ['DEAD', 'ALIVE'],
        indices: [],
        inactive: new Set(),
      })
    ).rejects.toThrow('__stop__');

    // With old code: DEAD's empty-page loop blocks forever, ALIVE never reached
    // With fix:      DEAD is marked complete (null firstTimestamp), ALIVE starts
    expect(startedSymbols).toContain('ALIVE');
  });
});

describe('runner — complete flag', () => {
  beforeEach(() => {
    (tablesModule.TABLES as TableConfig[]).length = 0;
    vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A sub-table previously marked complete should never be touched again —
  // no fetch calls, no state writes, nothing.
  it('skips sub-tables with complete: true in loaded state', async () => {
    (tablesModule.TABLES as TableConfig[]).push(INSTRUMENTS_TABLE);

    vi.mocked(global.fetch).mockImplementation(async () =>
      sentinelResponse('BUG: fetch called for complete sub-table')
    );

    const completedState = {
      _id: 'quote:DONE',
      start: 500,
      lastFetchedAt: new Date(),
      totalFetched: 500,
      firstTimestamp: '2020-01-01T00:00:00.000Z',
      block: 0,
      blockStartTime: null,
      lastSeenTimestamp: '2020-01-15T00:00:00.000Z',
      complete: true,
    };

    const states = new Map([['quote:DONE', completedState as any]]);

    // With current code: no complete check → enters fetch loop → sentinel fires → rejects
    // With fix:          complete is true → skipped entirely → resolves
    await expect(
      runAllTables(mockService, makePersistence(), {
        states,
        instruments: ['DONE'],
        indices: [],
        inactive: new Set(),
      })
    ).resolves.toBeUndefined();

    expect(global.fetch).not.toHaveBeenCalled();
  });

  // When firstTimestamp comes back null (no historical data for this symbol),
  // the sub-table should be marked complete so it's never retried.
  it('marks symbols with null firstTimestamp as complete', async () => {
    (tablesModule.TABLES as TableConfig[]).push(INSTRUMENTS_TABLE);

    vi.mocked(global.fetch).mockImplementation(async (url) => {

      if (String(url).includes('count=1')) {
        return okResponse([]); // fetchFirstTimestamp returns null
      }

      return sentinelResponse('BUG: page loop entered for null firstTimestamp');
    });

    const states = new Map();
    const persistence = makePersistence();

    // With current code: enters page loop → sentinel fires → rejects
    // With fix:          null firstTimestamp → mark complete → skip → resolves
    await expect(
      runAllTables(mockService, persistence, {
        states,
        instruments: ['NOSYMBOL'],
        indices: [],
        inactive: new Set(),
      })
    ).resolves.toBeUndefined();

    const state = states.get('quote:NOSYMBOL');

    expect(state).toBeDefined();
    expect((state as any).complete).toBe(true);
  });

  // Unlisted symbols are fetched fully, but once the page loop hits an empty
  // page the runner marks them complete instead of waiting for new data.
  it('marks inactive symbols as complete when exhausted', async () => {
    (tablesModule.TABLES as TableConfig[]).push(INSTRUMENTS_TABLE);

    vi.mocked(global.fetch).mockImplementation(async (url) => {

      if (String(url).includes('count=1')) {
        return okResponse([{ timestamp: '2015-01-01T00:00:00.000Z' }]);
      }

      // First page returns data, second returns empty (exhausted)
      return okResponse([]);
    });

    const states = new Map();
    const persistence = makePersistence();

    await expect(
      runAllTables(mockService, persistence, {
        states,
        instruments: ['GONE'],
        indices: [],
        inactive: new Set(['GONE']),
      })
    ).resolves.toBeUndefined();

    // Verify it actually fetched (not skipped before fetching)
    expect(global.fetch).toHaveBeenCalled();

    const state = states.get('quote:GONE');

    expect(state).toBeDefined();
    expect((state as any).complete).toBe(true);
  });
});
