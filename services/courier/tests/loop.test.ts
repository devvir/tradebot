import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FetchClientHandle, RedisClient } from '@devvir/service-kit';
import { syncTable } from '../src/loop';

vi.mock('../src/download', () => ({
  listVaultDates: vi.fn(),
  fetchAndStore:  vi.fn().mockResolvedValue(true),
}));

import * as download from '../src/download';

/** Sentinel — `syncTable` only passes it straight through to the mocked download fns. */
const vault = {} as FetchClientHandle;

const makeRedis = (storedDate: string | null = null): RedisClient =>
  ({ get: vi.fn().mockResolvedValue(storedDate), set: vi.fn().mockResolvedValue(undefined) }) as unknown as RedisClient;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Generates all YYYYMMDD strings from `from` to `to` inclusive.
const dateRange = (from: string, to: string): string[] => {
  const dates: string[] = [];
  const d   = new Date(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}T00:00:00Z`);
  const end = new Date(`${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6, 8)}T00:00:00Z`);

  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
    d.setUTCDate(d.getUTCDate() + 1);
  }

  return dates;
};

// ── syncTable ─────────────────────────────────────────────────────────────────

describe('loop — syncTable', () => {
  beforeEach(() => {
    vi.mocked(download.fetchAndStore).mockReset();
    vi.mocked(download.fetchAndStore).mockResolvedValue(true);
  });

  it('calls fetchAndStore only for dates not already in vault', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-05T12:00:00Z')); // yesterday = 20250104

    // Vault has everything up to and including 20250102 — 20250103 and 20250104 are missing.
    const existing = dateRange('20141122', '20250102');

    vi.mocked(download.listVaultDates).mockResolvedValue(existing);

    await syncTable(vault, 'trade', makeRedis());

    expect(download.fetchAndStore).toHaveBeenCalledTimes(2);
    expect(download.fetchAndStore).toHaveBeenCalledWith(vault, 'trade', '20250103');
    expect(download.fetchAndStore).toHaveBeenCalledWith(vault, 'trade', '20250104');

    vi.useRealTimers();
  });

  it('resumes from the day after the last successfully downloaded date in redis', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-05T12:00:00Z')); // yesterday = 20250104

    vi.mocked(download.listVaultDates).mockResolvedValue([]);

    const redis = makeRedis('20250102'); // last success = 20250102 → resume from 20250103

    await syncTable(vault, 'trade', redis);

    expect(download.fetchAndStore).toHaveBeenCalledTimes(2);
    expect(download.fetchAndStore).toHaveBeenNthCalledWith(1, vault, 'trade', '20250103');
    expect(download.fetchAndStore).toHaveBeenNthCalledWith(2, vault, 'trade', '20250104');

    vi.useRealTimers();
  });

  it('advances redis to the date just downloaded after each success', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-05T12:00:00Z'));

    vi.mocked(download.listVaultDates).mockResolvedValue(dateRange('20141122', '20250102'));

    const redis = makeRedis();

    await syncTable(vault, 'trade', redis);

    expect(redis.set).toHaveBeenNthCalledWith(1, 'courier_trade', '20250103');
    expect(redis.set).toHaveBeenNthCalledWith(2, 'courier_trade', '20250104');

    vi.useRealTimers();
  });

  it('stops without advancing redis when a date is not yet published (404)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-05T12:00:00Z')); // yesterday = 20250104

    vi.mocked(download.listVaultDates).mockResolvedValue(dateRange('20141122', '20250102'));
    vi.mocked(download.fetchAndStore)
      .mockResolvedValueOnce(true)   // 20250103 stored
      .mockResolvedValueOnce(false); // 20250104 not yet published

    const redis = makeRedis();

    await syncTable(vault, 'trade', redis);

    expect(download.fetchAndStore).toHaveBeenCalledTimes(2);
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith('courier_trade', '20250103');

    vi.useRealTimers();
  });

  it('does not call fetchAndStore when vault is fully up to date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-03T12:00:00Z')); // yesterday = 20250102

    const existing = dateRange('20141122', '20250102');

    vi.mocked(download.listVaultDates).mockResolvedValue(existing);

    await syncTable(vault, 'trade', makeRedis());

    expect(download.fetchAndStore).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('downloads all dates when vault is empty', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2014-11-25T00:00:00Z')); // yesterday = 20141124

    vi.mocked(download.listVaultDates).mockResolvedValue([]);

    await syncTable(vault, 'trade', makeRedis());

    // Should download 20141122, 20141123, 20141124
    expect(download.fetchAndStore).toHaveBeenCalledTimes(3);
    expect(download.fetchAndStore).toHaveBeenNthCalledWith(1, vault, 'trade', '20141122');
    expect(download.fetchAndStore).toHaveBeenNthCalledWith(2, vault, 'trade', '20141123');
    expect(download.fetchAndStore).toHaveBeenNthCalledWith(3, vault, 'trade', '20141124');

    vi.useRealTimers();
  });
});
