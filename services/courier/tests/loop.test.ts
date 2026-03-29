import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncTable, syncAll } from '../src/loop';

vi.mock('../src/download', () => ({
  listVaultDates: vi.fn(),
  fetchAndStore:  vi.fn().mockResolvedValue(undefined),
}));

import * as download from '../src/download';

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
    vi.mocked(download.fetchAndStore).mockResolvedValue(undefined);
  });

  it('calls fetchAndStore only for dates not already in vault', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-05T12:00:00Z')); // yesterday = 20250104

    // Vault has everything up to and including 20250102 — 20250103 and 20250104 are missing.
    const existing = dateRange('20141122', '20250102');

    vi.mocked(download.listVaultDates).mockResolvedValue(existing);

    await syncTable('http://vault', 'trade');

    expect(download.fetchAndStore).toHaveBeenCalledTimes(2);
    expect(download.fetchAndStore).toHaveBeenCalledWith('http://vault', 'trade', '20250103');
    expect(download.fetchAndStore).toHaveBeenCalledWith('http://vault', 'trade', '20250104');

    vi.useRealTimers();
  });

  it('does not call fetchAndStore when vault is fully up to date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-03T12:00:00Z')); // yesterday = 20250102

    const existing = dateRange('20141122', '20250102');

    vi.mocked(download.listVaultDates).mockResolvedValue(existing);

    await syncTable('http://vault', 'trade');

    expect(download.fetchAndStore).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('downloads all dates when vault is empty', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2014-11-25T00:00:00Z')); // yesterday = 20141124

    vi.mocked(download.listVaultDates).mockResolvedValue([]);

    await syncTable('http://vault', 'trade');

    // Should download 20141122, 20141123, 20141124
    expect(download.fetchAndStore).toHaveBeenCalledTimes(3);
    expect(download.fetchAndStore).toHaveBeenNthCalledWith(1, 'http://vault', 'trade', '20141122');
    expect(download.fetchAndStore).toHaveBeenNthCalledWith(2, 'http://vault', 'trade', '20141123');
    expect(download.fetchAndStore).toHaveBeenNthCalledWith(3, 'http://vault', 'trade', '20141124');

    vi.useRealTimers();
  });
});

// ── syncAll ───────────────────────────────────────────────────────────────────

describe('loop — syncAll', () => {
  it('syncs both trade and quote tables', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-03T12:00:00Z'));

    vi.mocked(download.listVaultDates).mockResolvedValue(dateRange('20141122', '20250102'));

    await syncAll('http://vault');

    expect(download.listVaultDates).toHaveBeenCalledWith('http://vault', 'trade');
    expect(download.listVaultDates).toHaveBeenCalledWith('http://vault', 'quote');

    vi.useRealTimers();
  });
});
