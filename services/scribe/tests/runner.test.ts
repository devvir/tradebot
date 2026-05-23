import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { processTable } from '../src/runner';
import type { TableConfig } from '../src/types';
import type { FetchService, Row } from '../src/bitmex';
import type { StoreService } from '../src/vault';
import type { RedisClient } from '@devvir/service-kit';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../src/utils/throttling', () => ({
  sleep:        vi.fn().mockResolvedValue(undefined),
  waitIfNeeded: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/utils/symbols', () => ({
  getOrderedIndices: vi.fn().mockResolvedValue([]),
}));

// TABLES is mutable so each test can inject just the table it needs.
vi.mock('../src/utils/tables', () => ({
  TABLES:    [] as TableConfig[],
  PAGE_SIZE: 500,
}));

import * as tablesModule    from '../src/utils/tables';
import { sleep }            from '../src/utils/throttling';
import { getOrderedIndices } from '../src/utils/symbols';

/**
 * Mirrors index.ts: process every TABLES entry concurrently. Tests use this
 * via a small wrapper that also seeds the indices the compositeIndex loop
 * sees, so each test stays a single call.
 */
const runAllTables = (
  fetch:   FetchService,
  store:   StoreService,
  cache:   RedisClient,
  indices: string[],
): Promise<unknown> => {
  vi.mocked(getOrderedIndices).mockResolvedValue(indices);

  return Promise.all(
    (tablesModule.TABLES as TableConfig[]).map(t => processTable(t, fetch, store, cache)),
  );
};

// ── Fixed tables ─────────────────────────────────────────────────────────────

const SIMPLE_TABLE: TableConfig = {
  name:     'funding',
  path:     '/funding',
  maxStart: null,
  count:    500,
};

const COMPOSITE_TABLE: TableConfig = {
  name:     'compositeIndex',
  path:     '/instrument/compositeIndex',
  maxStart: null,
  count:    1000,
};

// ── Date helpers ──────────────────────────────────────────────────────────────

const offsetDate = (days: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
};

const YESTERDAY    = offsetDate(-1);
const TWO_DAYS_AGO = offsetDate(-2);

// Builds a Row with a timestamp for the given YYYYMMDD date.
const tsRow = (date: string): Row => ({
  timestamp: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T12:00:00.000Z`,
});

// ── Service factories ─────────────────────────────────────────────────────────

async function* rowGen(rows: Row[]): AsyncGenerator<Row> {
  for (const row of rows) yield row;
}

const makeFetch = (overrides: Partial<FetchService> = {}): FetchService => ({
  oldest:  vi.fn().mockResolvedValue(null),
  newest:  vi.fn().mockResolvedValue(null),
  getRows: vi.fn().mockImplementation(() => rowGen([])),
  getDay:  vi.fn().mockImplementation(() => rowGen([])),
  ...overrides,
});

const makeStore = (overrides: Partial<StoreService> = {}): StoreService => ({
  writeRows:  vi.fn().mockResolvedValue(undefined),
  closeFile:  vi.fn().mockResolvedValue(undefined),
  deleteFile: vi.fn().mockResolvedValue(undefined),
  listFiles:  vi.fn().mockResolvedValue({}),
  ...overrides,
});

const makeCache = (overrides: Partial<RedisClient> = {}): RedisClient => ({
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  ...overrides,
} as unknown as RedisClient);

// Throws on the Nth sleep call so the infinite loop exits cleanly.
const stopAfter = (n: number): void => {
  let calls = 0;
  vi.mocked(sleep).mockImplementation(() => {
    if (++calls >= n) throw new Error('stop');
    return Promise.resolve();
  });
};

// ── Tests: simple table ───────────────────────────────────────────────────────

describe('runAllTables — simple table', () => {
  beforeEach(() => { (tablesModule.TABLES as TableConfig[]).length = 0; });
  afterEach(() => vi.restoreAllMocks());

  it('fetches rows for a past day, writes them and closes the day', async () => {
    (tablesModule.TABLES as TableConfig[]).push(SIMPLE_TABLE);

    const row   = tsRow(YESTERDAY);
    const fetch = makeFetch({
      oldest: vi.fn().mockResolvedValue(tsRow(TWO_DAYS_AGO)),
      getDay: vi.fn().mockImplementation(() => rowGen([row])),
    });
    const store = makeStore({
      listFiles: vi.fn().mockResolvedValue({ [TWO_DAYS_AGO]: 'closed' }),
    });

    stopAfter(1);

    await expect(
      runAllTables(fetch, store, makeCache(), [])
    ).rejects.toThrow('stop');

    expect(store.writeRows).toHaveBeenCalledWith('funding', YESTERDAY, [row]);
    expect(store.closeFile).toHaveBeenCalledWith('funding', YESTERDAY);
  });

  it('skips oldest() probe when cache has a start date', async () => {
    (tablesModule.TABLES as TableConfig[]).push(SIMPLE_TABLE);

    // Return a real row so the empty-day probe path is not triggered — this
    // test is only concerned with the cold-start probe being skipped on resume.
    const fetch = makeFetch({
      getDay: vi.fn().mockImplementation(() => rowGen([tsRow(YESTERDAY)])),
    });
    const store = makeStore({
      listFiles: vi.fn().mockResolvedValue({ [TWO_DAYS_AGO]: 'closed' }),
    });
    const cache = makeCache({
      get: vi.fn().mockResolvedValue(YESTERDAY),
    });

    stopAfter(1);

    await expect(
      runAllTables(fetch, store, cache, [])
    ).rejects.toThrow('stop');

    expect(fetch.oldest).not.toHaveBeenCalled();
  });

  it('calls oldest() when there is no vault history', async () => {
    (tablesModule.TABLES as TableConfig[]).push(SIMPLE_TABLE);

    const fetch = makeFetch({
      oldest: vi.fn().mockResolvedValue(tsRow(YESTERDAY)),
      getDay: vi.fn().mockImplementation(() => rowGen([])),
    });
    const store = makeStore({
      listFiles: vi.fn().mockResolvedValue({}),
    });

    stopAfter(1);

    await expect(
      runAllTables(fetch, store, makeCache(), [])
    ).rejects.toThrow('stop');

    expect(fetch.oldest).toHaveBeenCalled();
  });

  it('deletes open files on startup', async () => {
    (tablesModule.TABLES as TableConfig[]).push(SIMPLE_TABLE);

    const store = makeStore({
      listFiles: vi.fn().mockResolvedValue({ '20200101': 'open' }),
    });

    stopAfter(1);

    await expect(
      runAllTables(makeFetch(), store, makeCache(), [])
    ).rejects.toThrow('stop');

    expect(store.deleteFile).toHaveBeenCalledWith('funding', '20200101');
  });

  it('flushes mid-buffer at FLUSH_THRESHOLD and again at end', async () => {
    (tablesModule.TABLES as TableConfig[]).push(SIMPLE_TABLE);

    // 10_001 rows — triggers one mid-flush at FLUSH_THRESHOLD (10_000) and one final flush.
    const rows = Array.from({ length: 10_001 }, () => tsRow(YESTERDAY));

    const fetch = makeFetch({
      oldest: vi.fn().mockResolvedValue(tsRow(TWO_DAYS_AGO)),
      getDay: vi.fn().mockImplementation(() => rowGen(rows)),
    });
    const store = makeStore({
      listFiles: vi.fn().mockResolvedValue({ [TWO_DAYS_AGO]: 'closed' }),
    });

    stopAfter(1);

    await expect(
      runAllTables(fetch, store, makeCache(), [])
    ).rejects.toThrow('stop');

    expect(store.writeRows).toHaveBeenCalledTimes(2);
  });

  it('propagates a single-task table filter to getDay', async () => {
    (tablesModule.TABLES as TableConfig[]).push({
      name: 'tick', path: '/trade', maxStart: null, count: 1000, filter: { size: 0 },
    });

    const fetch = makeFetch({
      oldest: vi.fn().mockResolvedValue(tsRow(TWO_DAYS_AGO)),
      getDay: vi.fn().mockImplementation(() => rowGen([])),
    });
    const store = makeStore({
      listFiles: vi.fn().mockResolvedValue({ [TWO_DAYS_AGO]: 'closed' }),
    });

    stopAfter(1);

    await expect(
      runAllTables(fetch, store, makeCache(), [])
    ).rejects.toThrow('stop');

    expect(fetch.getDay).toHaveBeenCalledWith(
      expect.anything(),
      YESTERDAY,
      { count: 1000, filter: { size: 0 } },
    );
  });
});

// ── Tests: compositeIndex ─────────────────────────────────────────────────────

describe('runAllTables — compositeIndex', () => {
  beforeEach(() => { (tablesModule.TABLES as TableConfig[]).length = 0; });
  afterEach(() => vi.restoreAllMocks());

  it('creates a separate task per symbol from getIndices', async () => {
    (tablesModule.TABLES as TableConfig[]).push(COMPOSITE_TABLE);

    const calledSymbols: string[] = [];
    const fetch = makeFetch({
      oldest: vi.fn().mockResolvedValue(tsRow(TWO_DAYS_AGO)),
      getDay: vi.fn().mockImplementation((_t, _d, filter) => {
        if (filter?.symbol) calledSymbols.push(filter.symbol);
        return rowGen([]);
      }),
    });
    const store = makeStore({
      listFiles: vi.fn().mockResolvedValue({ [TWO_DAYS_AGO]: 'closed' }),
    });

    stopAfter(1);

    await expect(
      runAllTables(fetch, store, makeCache(), ['.BXBT', '.ETHXBT'])
    ).rejects.toThrow('stop');

    expect(calledSymbols).toContain('.BXBT');
    expect(calledSymbols).toContain('.ETHXBT');
  });

  it('passes symbol and count:1000 as filter for compositeIndex tasks', async () => {
    (tablesModule.TABLES as TableConfig[]).push(COMPOSITE_TABLE);

    const fetch = makeFetch({
      oldest: vi.fn().mockResolvedValue(tsRow(TWO_DAYS_AGO)),
      getDay: vi.fn().mockImplementation(() => rowGen([])),
    });
    const store = makeStore({
      listFiles: vi.fn().mockResolvedValue({ [TWO_DAYS_AGO]: 'closed' }),
    });

    stopAfter(1);

    await expect(
      runAllTables(fetch, store, makeCache(), ['.BXBT'])
    ).rejects.toThrow('stop');

    expect(fetch.getDay).toHaveBeenCalledWith(
      expect.anything(),
      YESTERDAY,
      { symbol: '.BXBT', count: 1000 },
    );
  });

  it('propagates the table filter to per-symbol getDay calls', async () => {
    (tablesModule.TABLES as TableConfig[]).push({ ...COMPOSITE_TABLE, filter: { reference: 'BMI' } });

    const fetch = makeFetch({
      oldest: vi.fn().mockResolvedValue(tsRow(TWO_DAYS_AGO)),
      getDay: vi.fn().mockImplementation(() => rowGen([])),
    });
    const store = makeStore({
      listFiles: vi.fn().mockResolvedValue({ [TWO_DAYS_AGO]: 'closed' }),
    });

    stopAfter(1);

    await expect(
      runAllTables(fetch, store, makeCache(), ['.BXBT'])
    ).rejects.toThrow('stop');

    expect(fetch.getDay).toHaveBeenCalledWith(
      expect.anything(),
      YESTERDAY,
      { symbol: '.BXBT', count: 1000, filter: { reference: 'BMI' } },
    );
  });
});

// ── Tests: next[id] tracking ──────────────────────────────────────────────────

describe('runAllTables — next[id] tracking', () => {
  beforeEach(() => { (tablesModule.TABLES as TableConfig[]).length = 0; });
  afterEach(() => vi.restoreAllMocks());

  it('skips a symbol whose first data starts after currentDate', async () => {
    (tablesModule.TABLES as TableConfig[]).push(COMPOSITE_TABLE);

    // .EARLY has data from yesterday; .LATE has no data → next = today → skipped
    const calledSymbols: string[] = [];
    const fetch = makeFetch({
      oldest: vi.fn().mockImplementation((_t, filter) => {
        if (filter?.symbol === '.EARLY') return Promise.resolve(tsRow(YESTERDAY));
        return Promise.resolve(null);
      }),
      getDay: vi.fn().mockImplementation((_t, _d, filter) => {
        if (filter?.symbol) calledSymbols.push(filter.symbol as string);
        return rowGen([]);
      }),
    });
    const store = makeStore({ listFiles: vi.fn().mockResolvedValue({}) });

    stopAfter(1);

    await expect(
      runAllTables(fetch, store, makeCache(), ['.EARLY', '.LATE'])
    ).rejects.toThrow('stop');

    expect(calledSymbols).toContain('.EARLY');
    expect(calledSymbols).not.toContain('.LATE');
  });

  it('probes for next date and closes the day when getDay returns empty', async () => {
    (tablesModule.TABLES as TableConfig[]).push(SIMPLE_TABLE);

    // Cold start probe (no startTime) returns TWO_DAYS_AGO so initialDate is
    // a past date; the empty-day probe (with startTime) returns null so the
    // probeNextDate fallback path is exercised.
    const fetch = makeFetch({
      getDay:  vi.fn().mockImplementation(() => rowGen([])),
      oldest:  vi.fn().mockImplementation((_t, filter) =>
        Promise.resolve(filter?.startTime ? null : tsRow(TWO_DAYS_AGO))),
    });
    const store = makeStore({
      listFiles: vi.fn().mockResolvedValue({ [TWO_DAYS_AGO]: 'closed' }),
    });

    stopAfter(1);

    await expect(
      runAllTables(fetch, store, makeCache(), [])
    ).rejects.toThrow('stop');

    // Nothing to write on an empty day.
    expect(store.writeRows).not.toHaveBeenCalled();
    // Empty day still closes.
    expect(store.closeFile).toHaveBeenCalledWith('funding', YESTERDAY);
    // Probe fired with startTime set to the day after currentDate.
    expect(fetch.oldest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ startTime: expect.any(String) }),
    );
  });
});

// ── Tests: atomic per-day Redis confirmation ─────────────────────────────────
//
// Symbols with data must only have their progress written to Redis after the
// day's closeFile has succeeded. A crash mid-loop must leave Redis untouched
// for those symbols so the open .csv.gz.tmp (which gets wiped on restart) is
// re-fetched cleanly. Empty-day symbols save eagerly via probeNextDate —
// they have no data in the open file to lose.

describe('runAllTables — atomic per-day Redis confirmation', () => {
  beforeEach(() => { (tablesModule.TABLES as TableConfig[]).length = 0; });
  afterEach(() => vi.restoreAllMocks());

  it('saves data-bearing symbol progress only after closeFile', async () => {
    (tablesModule.TABLES as TableConfig[]).push(COMPOSITE_TABLE);

    const fetch = makeFetch({
      oldest: vi.fn().mockResolvedValue(tsRow(TWO_DAYS_AGO)),
      getDay: vi.fn().mockImplementation(() => rowGen([tsRow(YESTERDAY)])),
    });
    const store = makeStore({
      listFiles: vi.fn().mockResolvedValue({ [TWO_DAYS_AGO]: 'closed' }),
    });
    const cache = makeCache();

    stopAfter(1);

    await expect(
      runAllTables(fetch, store, cache, ['.A', '.B'])
    ).rejects.toThrow('stop');

    const setMock    = vi.mocked(cache.set);
    const closeMock  = vi.mocked(store.closeFile);
    const today      = offsetDate(0); // nextDay(YESTERDAY)
    const closeOrder = closeMock.mock.invocationCallOrder[0]!;

    for (const symbol of ['.A', '.B']) {
      const idx = setMock.mock.calls.findIndex(c =>
        c[0] === `scribe_compositeIndex_${symbol}` && c[1] === today,
      );

      expect(idx, `saveProgress for ${symbol} → ${today}`).toBeGreaterThanOrEqual(0);
      expect(setMock.mock.invocationCallOrder[idx]!).toBeGreaterThan(closeOrder);
    }
  });

  it('still saves progress eagerly for empty-day (probed) symbols', async () => {
    (tablesModule.TABLES as TableConfig[]).push(SIMPLE_TABLE);

    // Cold-start oldest (no startTime) returns TWO_DAYS_AGO; empty-day probe
    // (with startTime) returns null; newest also null → probeNextDate sets
    // the symbol as exhausted (todayUtc) and saves immediately.
    const fetch = makeFetch({
      getDay:  vi.fn().mockImplementation(() => rowGen([])),
      newest:  vi.fn().mockResolvedValue(null),
      oldest:  vi.fn().mockImplementation((_t, filter) =>
        Promise.resolve(filter?.startTime ? null : tsRow(TWO_DAYS_AGO))),
    });
    const store = makeStore({
      listFiles: vi.fn().mockResolvedValue({ [TWO_DAYS_AGO]: 'closed' }),
    });
    const cache = makeCache();

    stopAfter(1);

    await expect(
      runAllTables(fetch, store, cache, [])
    ).rejects.toThrow('stop');

    const setMock    = vi.mocked(cache.set);
    const closeMock  = vi.mocked(store.closeFile);
    const today      = offsetDate(0);
    const closeOrder = closeMock.mock.invocationCallOrder[0]!;

    // probeNextDate's save (today) ran inside the loop, before closeFile.
    const probeIdx = setMock.mock.calls.findIndex(c =>
      c[0] === 'scribe_funding_default' && c[1] === today,
    );

    expect(probeIdx).toBeGreaterThanOrEqual(0);
    expect(setMock.mock.invocationCallOrder[probeIdx]!).toBeLessThan(closeOrder);
  });
});
