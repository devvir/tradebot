import { describe, it, expect, vi, beforeEach } from 'vitest';
import { targetDates, syncDate, _test_BATCH_SIZE } from '../src/loop';
import type { TardyTable, WsMessage } from '../src/types';

vi.mock('../src/vault', () => ({
  listFiles:  vi.fn(),
  writeRows:  vi.fn().mockResolvedValue(undefined),
  closeFile:  vi.fn().mockResolvedValue(undefined),
  deleteFile: vi.fn().mockResolvedValue(undefined),
}));

// Keep MINUTES_PER_DAY small in tests so the outer minute loop completes
// quickly. 3 minutes is enough to exercise per-minute boundary flushing.
vi.mock('../src/tardis', () => ({
  streamMinute:    vi.fn(),
  MINUTES_PER_DAY: 3,
}));

// Config is a module-level singleton — mock it so tests don't need VAULT_URL.
vi.mock('../src/config', () => ({
  default: { vaultUrl: 'http://vault', startDate: '20190401', suffix: '' },
}));

import * as vault  from '../src/vault';
import * as tardis from '../src/tardis';

// ── targetDates ───────────────────────────────────────────────────────────────

describe('loop — targetDates', () => {
  it('generates first-of-month dates from startDate', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2019-07-10T12:00:00Z'));

    // cutoff = 2019-07-08 - walk back to 1st = 2019-07-01
    const dates = targetDates('20190401');

    expect(dates).toEqual(['20190401', '20190501', '20190601', '20190701']);

    vi.useRealTimers();
  });

  it('excludes a first-of-month date that is less than 2 days old', () => {
    vi.useFakeTimers();
    // May 1st + 2 days = May 3rd. Today is May 2nd, so May 1st is NOT yet eligible.
    vi.setSystemTime(new Date('2026-05-02T12:00:00Z'));

    const dates = targetDates('20260401');

    expect(dates).toEqual(['20260401']);
    expect(dates).not.toContain('20260501');

    vi.useRealTimers();
  });

  it('includes a first-of-month date once exactly 2 days have passed', () => {
    vi.useFakeTimers();
    // May 3rd 00:00 UTC: now - 2 days = May 1st → cutoff = 20260501.
    vi.setSystemTime(new Date('2026-05-03T00:00:00Z'));

    const dates = targetDates('20260401');

    expect(dates).toContain('20260501');

    vi.useRealTimers();
  });

  it('returns empty array when startDate is far beyond the cutoff', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2019-04-02T12:00:00Z'));

    const dates = targetDates('20191201');

    expect(dates).toEqual([]);

    vi.useRealTimers();
  });

  it('generates exactly one date when startDate equals the cutoff month', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2019-04-15T12:00:00Z'));

    const dates = targetDates('20190401');

    expect(dates).toEqual(['20190401']);

    vi.useRealTimers();
  });

  it('advances to the next month when startDate is not the 1st', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2019-07-10T12:00:00Z'));

    // startDate 20190330 (Tardis genesis) → iteration starts at 2019-04-01,
    // not 2019-03-01 which is before any Tardis archive data.
    const dates = targetDates('20190330');

    expect(dates[0]).toBe('20190401');
    expect(dates).not.toContain('20190301');

    vi.useRealTimers();
  });

  it('rolls the year when advancing from December', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-03-10T12:00:00Z'));

    const dates = targetDates('20191215');

    expect(dates[0]).toBe('20200101');

    vi.useRealTimers();
  });
});

// ── syncDate ──────────────────────────────────────────────────────────────────

describe('loop — syncDate', () => {
  const VAULT_URL = 'http://vault';
  const DATE      = '20190401';

  // Helper: builds a streamMinute mock that returns the given messages on the
  // specified offset and empty generators for every other offset. Keeps tests
  // intent-focused — most cases only care about one minute of data.
  const mockMinute = (
    offset: number,
    messages: Array<{ table: TardyTable; msg: WsMessage }>,
  ): void => {
    vi.mocked(tardis.streamMinute).mockImplementation((_date, off, _tables) => {
      const yieldMessages = off === offset ? messages : [];

      return (async function* () {
        for (const m of yieldMessages) yield m;
      })();
    });
  };

  beforeEach(() => {
    vi.mocked(vault.listFiles).mockReset();
    vi.mocked(vault.writeRows).mockReset().mockResolvedValue(undefined);
    vi.mocked(vault.closeFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(vault.deleteFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(tardis.streamMinute).mockReset();
  });

  it('skips a date when all 7 tables are already closed', async () => {
    vi.mocked(vault.listFiles).mockResolvedValue({ [DATE]: 'closed' });

    await syncDate(VAULT_URL, DATE);

    expect(tardis.streamMinute).not.toHaveBeenCalled();
  });

  it('includes a table when its file is missing from vault', async () => {
    vi.mocked(vault.listFiles).mockImplementation(async (_url, table) =>
      table === 'orderBookL2' ? {} : { [DATE]: 'closed' },
    );

    mockMinute(0, [
      { table: 'orderBookL2', msg: { action: 'insert', date: '2019-04-01T00:00:00.000Z', data: [] } },
    ]);

    await syncDate(VAULT_URL, DATE);

    expect(tardis.streamMinute).toHaveBeenCalledWith(DATE, 0, ['orderBookL2']);
    expect(vault.closeFile).toHaveBeenCalledWith(VAULT_URL, 'orderBookL2', DATE, '');
  });

  it('deletes an open file and re-includes that table', async () => {
    vi.mocked(vault.listFiles).mockImplementation(async (_url, table) =>
      table === 'instrument' ? { [DATE]: 'open' } : { [DATE]: 'closed' },
    );

    mockMinute(0, []);

    await syncDate(VAULT_URL, DATE);

    expect(vault.deleteFile).toHaveBeenCalledWith(VAULT_URL, 'instrument', DATE, '');
    expect(tardis.streamMinute).toHaveBeenCalledWith(DATE, 0, ['instrument']);
  });

  it('routes messages to the correct table bucket', async () => {
    vi.mocked(vault.listFiles).mockImplementation(async (_url, table) =>
      table === 'orderBookL2' || table === 'instrument' ? {} : { [DATE]: 'closed' },
    );

    const obRow   = { action: 'insert', date: '2019-04-01T00:00:00.000Z', data: [{ id: 1 }] };
    const instRow = { action: 'partial', date: '2019-04-01T00:00:01.000Z', data: [{ symbol: 'XBTUSD' }] };

    mockMinute(0, [
      { table: 'orderBookL2', msg: obRow },
      { table: 'instrument',  msg: instRow },
    ]);

    await syncDate(VAULT_URL, DATE);

    expect(vault.writeRows).toHaveBeenCalledWith(VAULT_URL, 'orderBookL2', DATE, [obRow],   '');
    expect(vault.writeRows).toHaveBeenCalledWith(VAULT_URL, 'instrument',  DATE, [instRow], '');
  });

  it('flushes mid-minute when a table batch hits BATCH_SIZE (10,000)', async () => {
    vi.mocked(vault.listFiles).mockImplementation(async (_url, table) =>
      table === 'liquidation' ? {} : { [DATE]: 'closed' },
    );

    const msg = { action: 'insert', date: '2019-04-01T00:00:00.000Z', data: [] };

    // Yield 10,001 messages within one minute to trigger an early size flush
    // followed by an end-of-minute flush of the remainder.
    const messages = Array.from({ length: _test_BATCH_SIZE + 1 }, () => ({ table: 'liquidation' as const, msg }));

    mockMinute(0, messages);

    await syncDate(VAULT_URL, DATE);

    expect(vault.writeRows).toHaveBeenCalledTimes(2);

    const firstCallRows  = vi.mocked(vault.writeRows).mock.calls[0]![3];
    const secondCallRows = vi.mocked(vault.writeRows).mock.calls[1]![3];

    expect(firstCallRows).toHaveLength(_test_BATCH_SIZE);
    expect(secondCallRows).toHaveLength(1);

    expect(vault.closeFile).toHaveBeenCalledWith(VAULT_URL, 'liquidation', DATE, '');
  });

  it('flushes every table at the end of each minute even if no size threshold is hit', async () => {
    vi.mocked(vault.listFiles).mockImplementation(async (_url, table) =>
      table === 'announcement' ? {} : { [DATE]: 'closed' },
    );

    const msg = { action: 'partial', date: '2019-04-01T00:00:00.000Z', data: [] };

    // One sparse message in minute 0, nothing in minutes 1-2. This is the
    // shape of the real-world bug: a single partial sat in the buffer for
    // the whole stream because nothing else triggered a flush for that table.
    vi.mocked(tardis.streamMinute).mockImplementation((_date, offset, _tables) => {
      const yieldMessages = offset === 0
        ? [{ table: 'announcement' as const, msg }]
        : [];

      return (async function* () {
        for (const m of yieldMessages) yield m;
      })();
    });

    await syncDate(VAULT_URL, DATE);

    // One writeRows call at the end of minute 0 — not deferred to stream end.
    expect(vault.writeRows).toHaveBeenCalledTimes(1);
    expect(vault.writeRows).toHaveBeenCalledWith(VAULT_URL, 'announcement', DATE, [msg], '');
  });

  it('flushes per minute when data spans multiple minutes', async () => {
    vi.mocked(vault.listFiles).mockImplementation(async (_url, table) =>
      table === 'connected' ? {} : { [DATE]: 'closed' },
    );

    const m0 = { action: 'insert', date: '2019-04-01T00:00:00.000Z', data: [] };
    const m1 = { action: 'insert', date: '2019-04-01T00:01:00.000Z', data: [] };
    const m2 = { action: 'insert', date: '2019-04-01T00:02:00.000Z', data: [] };

    vi.mocked(tardis.streamMinute).mockImplementation((_date, offset, _tables) => {
      const map: Record<number, WsMessage> = { 0: m0, 1: m1, 2: m2 };
      const msg = map[offset];

      return (async function* () {
        if (msg) yield { table: 'connected' as const, msg };
      })();
    });

    await syncDate(VAULT_URL, DATE);

    expect(vault.writeRows).toHaveBeenCalledTimes(3);
    expect(vi.mocked(vault.writeRows).mock.calls[0]![3]).toEqual([m0]);
    expect(vi.mocked(vault.writeRows).mock.calls[1]![3]).toEqual([m1]);
    expect(vi.mocked(vault.writeRows).mock.calls[2]![3]).toEqual([m2]);
  });

  it('closes all needed tables even when the stream yields no messages', async () => {
    vi.mocked(vault.listFiles).mockImplementation(async (_url, table) =>
      table === 'chat' || table === 'connected' ? {} : { [DATE]: 'closed' },
    );

    mockMinute(0, []);

    await syncDate(VAULT_URL, DATE);

    expect(vault.closeFile).toHaveBeenCalledWith(VAULT_URL, 'chat',      DATE, '');
    expect(vault.closeFile).toHaveBeenCalledWith(VAULT_URL, 'connected', DATE, '');
    expect(vault.writeRows).not.toHaveBeenCalled();
  });
});
