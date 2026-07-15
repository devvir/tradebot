import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FetchClientHandle } from '@devvir/service-kit';
import { listVaultDates, fetchAndStore } from '../src/download';

const mockFetch = vi.fn();

vi.stubGlobal('fetch', mockFetch);   // S3 downloads only — vault goes through the client

type MockVault = FetchClientHandle & {
  get:     ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
};

const makeVault = (): MockVault =>
  ({ get: vi.fn(), request: vi.fn() }) as unknown as MockVault;

// ── listVaultDates ────────────────────────────────────────────────────────────

describe('download — listVaultDates', () => {
  it('lists only its own .s3 sources and returns bare dates', async () => {
    const vault = makeVault();

    vault.get.mockResolvedValue({ '20250101.s3': 'closed', '20250102.s3': 'closed' });

    expect(await listVaultDates(vault, 'trade')).toEqual(['20250101', '20250102']);
    expect(vault.get).toHaveBeenCalledWith('/files/trade?suffix=s3', { passThrough: [404] });
  });

  it('returns an empty list when vault has no data for the table (404)', async () => {
    const vault = makeVault();

    // The 404 passThrough resolves to null in the client — courier must not crash.
    vault.get.mockResolvedValue(null);

    expect(await listVaultDates(vault, 'trade')).toEqual([]);
  });

  it('propagates a genuine vault error', async () => {
    const vault = makeVault();

    vault.get.mockRejectedValue(new Error('Vault list failed: HTTP 500'));

    await expect(listVaultDates(vault, 'trade')).rejects.toThrow('HTTP 500');
  });
});

// ── fetchAndStore ─────────────────────────────────────────────────────────────

describe('download — fetchAndStore', () => {
  beforeEach(() => mockFetch.mockReset());

  it('fetches from S3, PUTs to vault, and returns true', async () => {
    const body  = new ReadableStream();
    const vault = makeVault();

    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, body });
    vault.request.mockResolvedValue({ ok: true, status: 204 });

    const result = await fetchAndStore(vault, 'trade', '20250101');

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://s3-eu-west-1.amazonaws.com/public.bitmex.com/data/trade/20250101.csv.gz',
    );
    expect(vault.request).toHaveBeenCalledWith(
      '/files/trade/20250101?suffix=s3',
      expect.objectContaining({ method: 'PUT', body }),
    );
  });

  it('returns false when S3 returns 404 (not yet published)', async () => {
    const vault = makeVault();

    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await fetchAndStore(vault, 'trade', '20250101');

    expect(result).toBe(false);
    expect(vault.request).not.toHaveBeenCalled();
  });

  it('returns true when vault returns 409 (already exists)', async () => {
    const vault = makeVault();

    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, body: new ReadableStream() });
    vault.request.mockResolvedValue({ ok: false, status: 409 });

    await expect(fetchAndStore(vault, 'trade', '20250101')).resolves.toBe(true);
  });

  it('retries on transient failure then succeeds', async () => {
    vi.useFakeTimers();

    const vault = makeVault();

    mockFetch
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ ok: true, status: 200, body: new ReadableStream() });
    vault.request.mockResolvedValue({ ok: true, status: 204 });

    const promise = fetchAndStore(vault, 'trade', '20250101');

    await vi.runAllTimersAsync();
    await promise;

    expect(mockFetch).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('throws after exhausting all retries', async () => {
    vi.useFakeTimers();

    const vault = makeVault();

    mockFetch.mockResolvedValue({ ok: true, status: 200, body: new ReadableStream() });
    vault.request.mockResolvedValue({ ok: false, status: 500 });

    const settled = fetchAndStore(vault, 'trade', '20250101')
      .then(() => null as Error | null, (e: Error) => e);

    await vi.runAllTimersAsync();

    const err = await settled;

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe('Vault PUT HTTP 500');

    vi.useRealTimers();
  });
});
