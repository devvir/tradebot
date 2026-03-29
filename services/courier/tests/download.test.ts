import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listVaultDates, fetchAndStore } from '../src/download';

const mockFetch = vi.fn();

vi.stubGlobal('fetch', mockFetch);

// ── listVaultDates ────────────────────────────────────────────────────────────

describe('download — listVaultDates', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns parsed JSON array from vault', async () => {
    mockFetch.mockResolvedValue({
      ok:   true,
      json: () => Promise.resolve({ '20250101': 'closed', '20250102': 'closed' }),
    });

    const dates = await listVaultDates('http://vault', 'trade');

    expect(mockFetch).toHaveBeenCalledWith('http://vault/files/trade', undefined);
    expect(dates).toEqual(['20250101', '20250102']);
  });

  it('throws when vault returns a non-ok status', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    await expect(listVaultDates('http://vault', 'trade')).rejects.toThrow('HTTP 503');
  });
});

// ── fetchAndStore ─────────────────────────────────────────────────────────────

describe('download — fetchAndStore', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('fetches from S3 and PUTs to vault', async () => {
    const fakeBody = new ReadableStream();

    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, body: fakeBody }) // S3
      .mockResolvedValueOnce({ ok: true, status: 204 });                // vault

    await fetchAndStore('http://vault', 'trade', '20250101');

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://s3-eu-west-1.amazonaws.com/public.bitmex.com/data/trade/20250101.csv.gz',
    );

    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'http://vault/files/trade/20250101',
      expect.objectContaining({ method: 'PUT', body: fakeBody }),
    );
  });

  it('skips silently when S3 returns 404', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    await fetchAndStore('http://vault', 'trade', '20250101');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('skips silently when vault returns 409 (already exists)', async () => {
    const fakeBody = new ReadableStream();

    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, body: fakeBody })
      .mockResolvedValueOnce({ ok: false, status: 409 });

    await expect(fetchAndStore('http://vault', 'trade', '20250101')).resolves.toBeUndefined();
  });

  it('retries on transient fetch failure then succeeds', async () => {
    vi.useFakeTimers();

    const fakeBody = new ReadableStream();

    mockFetch
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ ok: true, status: 200, body: fakeBody })
      .mockResolvedValueOnce({ ok: true, status: 204 });

    const promise = fetchAndStore('http://vault', 'trade', '20250101');

    await vi.runAllTimersAsync();
    await promise;

    expect(mockFetch).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  it('throws after exhausting all retries', async () => {
    vi.useFakeTimers();

    // Each attempt: S3 succeeds, vault returns 500 → retried
    for (let i = 0; i < 5; i++) {
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200, body: new ReadableStream() })
        .mockResolvedValueOnce({ ok: false, status: 500 });
    }

    // Attach rejection handler synchronously to avoid unhandled-rejection warning
    const settled = fetchAndStore('http://vault', 'trade', '20250101')
      .then(() => null as Error | null, (e: Error) => e);

    await vi.runAllTimersAsync();

    const err = await settled;

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe('Vault PUT HTTP 500');

    vi.useRealTimers();
  });
});
