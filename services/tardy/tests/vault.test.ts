import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listFiles, writeRows, closeFile, deleteFile, _test_resetRetry } from '../src/vault';
import type { WsMessage } from '../src/types';

const mockFetch = vi.fn();

vi.stubGlobal('fetch', mockFetch);

const VAULT_URL = 'http://vault';

// ── listFiles ─────────────────────────────────────────────────────────────────

describe('vault — listFiles', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    _test_resetRetry();
  });

  it('returns file state map from vault', async () => {
    mockFetch.mockResolvedValue({
      ok:     true,
      status: 200,
      json:   () => Promise.resolve({ '20190401': 'closed', '20190501': 'open' }),
    });

    const result = await listFiles(VAULT_URL, 'orderBookL2');

    expect(mockFetch).toHaveBeenCalledWith('http://vault/files/orderBookL2', undefined);
    expect(result).toEqual({ '20190401': 'closed', '20190501': 'open' });
  });

  it('returns empty object when vault responds 404 (table not yet created)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });

    const result = await listFiles(VAULT_URL, 'instrument');

    expect(result).toEqual({});
  });

  it('throws after max retries on persistent non-ok, non-404 response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    await expect(listFiles(VAULT_URL, 'orderBookL2')).rejects.toThrow('max retries exhausted');

    expect(mockFetch).toHaveBeenCalledTimes(10);
  });
});

// ── writeRows ─────────────────────────────────────────────────────────────────

describe('vault — writeRows', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    _test_resetRetry();
  });

  const rows: WsMessage[] = [
    { action: 'insert', date: '2019-04-01T00:00:01.000Z', data: [{ symbol: 'XBTUSD' }] },
  ];

  it('POSTs rows to the correct vault endpoint', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 202 });

    await writeRows(VAULT_URL, 'orderBookL2', '20190401', rows);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://vault/files/orderBookL2/20190401/rows',
      expect.objectContaining({
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(rows),
      }),
    );
  });

  it('drops the batch silently on 409 (closing)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 409 });

    await expect(writeRows(VAULT_URL, 'orderBookL2', '20190401', rows)).resolves.toBeUndefined();
  });

  it('drops the batch silently on 418 (sealed)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 418 });

    await expect(writeRows(VAULT_URL, 'orderBookL2', '20190401', rows)).resolves.toBeUndefined();
  });

  it('throws after max retries on persistent error status', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await expect(writeRows(VAULT_URL, 'orderBookL2', '20190401', rows)).rejects.toThrow('max retries exhausted');

    expect(mockFetch).toHaveBeenCalledTimes(10);
  });

  it('retries on failure and succeeds when vault recovers', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValue({ ok: true, status: 202 });

    await writeRows(VAULT_URL, 'orderBookL2', '20190401', rows);

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('retries on network error and succeeds when vault recovers', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue({ ok: true, status: 202 });

    await writeRows(VAULT_URL, 'orderBookL2', '20190401', rows);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ── closeFile ─────────────────────────────────────────────────────────────────

describe('vault — closeFile', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    _test_resetRetry();
  });

  it('POSTs to the close endpoint', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 202 });

    await closeFile(VAULT_URL, 'orderBookL2', '20190401');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://vault/files/orderBookL2/20190401/close',
      { method: 'POST' },
    );
  });

  it('resolves silently on 404 (file already gone)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });

    await expect(closeFile(VAULT_URL, 'orderBookL2', '20190401')).resolves.toBeUndefined();
  });

  it('throws after max retries on persistent error status', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await expect(closeFile(VAULT_URL, 'orderBookL2', '20190401')).rejects.toThrow('max retries exhausted');
  });
});

// ── deleteFile ────────────────────────────────────────────────────────────────

describe('vault — deleteFile', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    _test_resetRetry();
  });

  it('sends DELETE to the correct vault endpoint', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 202 });

    await deleteFile(VAULT_URL, 'orderBookL2', '20190401');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://vault/files/orderBookL2/20190401',
      { method: 'DELETE' },
    );
  });

  it('resolves silently on 404', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });

    await expect(deleteFile(VAULT_URL, 'instrument', '20190401')).resolves.toBeUndefined();
  });

  it('throws after max retries on persistent error status', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await expect(deleteFile(VAULT_URL, 'instrument', '20190401')).rejects.toThrow('max retries exhausted');
  });
});
