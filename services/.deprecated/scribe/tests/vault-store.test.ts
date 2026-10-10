import { describe, it, expect, vi } from 'vitest';
import type { FetchClientHandle } from '@devvir/service-kit';
import { createStoreService } from '../src/vault';

// Retry, backoff, and transition logging are the `vault` client's job (covered
// by service-kit's tests). These cover scribe's store logic: paths and response
// handling.

type MockVault = FetchClientHandle & {
  get:     ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
};

const makeVault = (): MockVault =>
  ({ get: vi.fn(), request: vi.fn() }) as unknown as MockVault;

const okRes  = (status = 200): Response => ({ ok: true,  status }) as Response;
const errRes = (status: number): Response => ({ ok: false, status }) as Response;

// ── writeRows ─────────────────────────────────────────────────────────────────

describe('StoreService — writeRows', () => {
  it('POSTs JSON rows to the correct endpoint', async () => {
    const vault = makeVault();

    vault.request.mockResolvedValue(okRes(202));

    await createStoreService(vault).writeRows('funding', '20200101', [{ price: 100 }]);

    expect(vault.request).toHaveBeenCalledWith(
      '/files/funding/20200101/rows',
      expect.objectContaining({
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify([{ price: 100 }]),
      }),
    );
  });

  it('throws when vault rejects the write', async () => {
    const vault = makeVault();

    vault.request.mockResolvedValue(errRes(500));

    await expect(createStoreService(vault).writeRows('funding', '20200101', []))
      .rejects.toThrow('HTTP 500');
  });
});

// ── closeFile ─────────────────────────────────────────────────────────────────

describe('StoreService — closeFile', () => {
  it('POSTs to the close endpoint', async () => {
    const vault = makeVault();

    vault.request.mockResolvedValue(okRes(204));

    await createStoreService(vault).closeFile('funding', '20200101');

    expect(vault.request).toHaveBeenCalledWith(
      '/files/funding/20200101/close',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('does not throw on 404 (file already gone)', async () => {
    const vault = makeVault();

    vault.request.mockResolvedValue(errRes(404));

    await expect(createStoreService(vault).closeFile('funding', '20200101')).resolves.toBeUndefined();
  });

  it('throws on other errors', async () => {
    const vault = makeVault();

    vault.request.mockResolvedValue(errRes(500));

    await expect(createStoreService(vault).closeFile('funding', '20200101')).rejects.toThrow('HTTP 500');
  });
});

// ── deleteFile ────────────────────────────────────────────────────────────────

describe('StoreService — deleteFile', () => {
  it('sends a DELETE request to the correct endpoint', async () => {
    const vault = makeVault();

    vault.request.mockResolvedValue(okRes(204));

    await createStoreService(vault).deleteFile('funding', '20200101');

    expect(vault.request).toHaveBeenCalledWith(
      '/files/funding/20200101',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('does not throw on 404', async () => {
    const vault = makeVault();

    vault.request.mockResolvedValue(errRes(404));

    await expect(createStoreService(vault).deleteFile('funding', '20200101')).resolves.toBeUndefined();
  });

  it('throws on other errors', async () => {
    const vault = makeVault();

    vault.request.mockResolvedValue(errRes(500));

    await expect(createStoreService(vault).deleteFile('funding', '20200101')).rejects.toThrow('HTTP 500');
  });
});

// ── listFiles ─────────────────────────────────────────────────────────────────

describe('StoreService — listFiles', () => {
  it('returns the file listing from vault', async () => {
    const vault   = makeVault();
    const listing = { '20200101': 'closed', '20200102': 'open' };

    vault.get.mockResolvedValue(listing);

    expect(await createStoreService(vault).listFiles('funding')).toEqual(listing);
    expect(vault.get).toHaveBeenCalledWith('/files/funding', { passThrough: [404] });
  });

  it('returns an empty object when vault returns 404 (passThrough → null)', async () => {
    const vault = makeVault();

    vault.get.mockResolvedValue(null);

    expect(await createStoreService(vault).listFiles('funding')).toEqual({});
  });

  it('throws on other errors', async () => {
    const vault = makeVault();

    vault.get.mockRejectedValue(new Error('GET /files/funding failed (HTTP 500)'));

    await expect(createStoreService(vault).listFiles('funding')).rejects.toThrow('HTTP 500');
  });
});
