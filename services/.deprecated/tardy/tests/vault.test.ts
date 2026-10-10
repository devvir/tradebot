import { describe, it, expect, vi } from 'vitest';
import type { FetchClientHandle } from '@devvir/service-kit';
import { listFiles, writeRows, closeFile, deleteFile } from '../src/vault';
import type { WsMessage } from '../src/types';

// Retry, backoff, and transition logging are the `vault` client's job (and are
// covered by service-kit's own tests). These tests cover tardy's vault logic:
// path building, the suffix query, and response handling.

type MockVault = FetchClientHandle & {
  get:     ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
};

const makeVault = (): MockVault =>
  ({ get: vi.fn(), request: vi.fn() }) as unknown as MockVault;

// ── listFiles ─────────────────────────────────────────────────────────────────

describe('vault — listFiles', () => {
  it('returns the file-state map from vault (no suffix)', async () => {
    const vault = makeVault();

    vault.get.mockResolvedValue({ '20190401': 'closed', '20190501': 'open' });

    const result = await listFiles(vault, 'orderBookL2', '');

    expect(vault.get).toHaveBeenCalledWith('/files/orderBookL2', { passThrough: [404] });
    expect(result).toEqual({ '20190401': 'closed', '20190501': 'open' });
  });

  it('appends ?suffix= to the path when suffix is non-empty', async () => {
    const vault = makeVault();

    vault.get.mockResolvedValue({});

    await listFiles(vault, 'orderBookL2', 'tardy');

    expect(vault.get).toHaveBeenCalledWith('/files/orderBookL2?suffix=tardy', { passThrough: [404] });
  });

  it('returns an empty object when vault responds 404 (passThrough → null)', async () => {
    const vault = makeVault();

    vault.get.mockResolvedValue(null);

    expect(await listFiles(vault, 'instrument', '')).toEqual({});
  });
});

// ── writeRows ─────────────────────────────────────────────────────────────────

describe('vault — writeRows', () => {
  const rows: WsMessage[] = [
    { action: 'insert', date: '2019-04-01T00:00:01.000Z', data: [{ symbol: 'XBTUSD' }] },
  ];

  it('POSTs rows to the correct vault path (no suffix)', async () => {
    const vault = makeVault();

    vault.request.mockResolvedValue({ ok: true, status: 202 });

    await writeRows(vault, 'orderBookL2', '20190401', rows, '');

    expect(vault.request).toHaveBeenCalledWith(
      '/files/orderBookL2/20190401/rows',
      expect.objectContaining({
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(rows),
      }),
    );
  });

  it('appends ?suffix= to the path when suffix is non-empty', async () => {
    const vault = makeVault();

    vault.request.mockResolvedValue({ ok: true, status: 202 });

    await writeRows(vault, 'orderBookL2', '20190401', rows, 'tardy');

    expect(vault.request).toHaveBeenCalledWith(
      '/files/orderBookL2/20190401/rows?suffix=tardy',
      expect.anything(),
    );
  });

  it('drops the batch silently on 409 (closing)', async () => {
    const vault = makeVault();

    vault.request.mockResolvedValue({ ok: false, status: 409 });

    await expect(writeRows(vault, 'orderBookL2', '20190401', rows, '')).resolves.toBeUndefined();
  });

  it('drops the batch silently on 418 (sealed)', async () => {
    const vault = makeVault();

    vault.request.mockResolvedValue({ ok: false, status: 418 });

    await expect(writeRows(vault, 'orderBookL2', '20190401', rows, '')).resolves.toBeUndefined();
  });
});

// ── closeFile ─────────────────────────────────────────────────────────────────

describe('vault — closeFile', () => {
  it('POSTs to the close endpoint (no suffix)', async () => {
    const vault = makeVault();

    vault.request.mockResolvedValue({ ok: true, status: 202 });

    await closeFile(vault, 'orderBookL2', '20190401', '');

    expect(vault.request).toHaveBeenCalledWith('/files/orderBookL2/20190401/close', { method: 'POST' });
  });

  it('appends ?suffix= to the path when suffix is non-empty', async () => {
    const vault = makeVault();

    vault.request.mockResolvedValue({ ok: true, status: 202 });

    await closeFile(vault, 'orderBookL2', '20190401', 'tardy');

    expect(vault.request).toHaveBeenCalledWith('/files/orderBookL2/20190401/close?suffix=tardy', { method: 'POST' });
  });
});

// ── deleteFile ────────────────────────────────────────────────────────────────

describe('vault — deleteFile', () => {
  it('sends DELETE to the correct vault path (no suffix)', async () => {
    const vault = makeVault();

    vault.request.mockResolvedValue({ ok: true, status: 202 });

    await deleteFile(vault, 'orderBookL2', '20190401', '');

    expect(vault.request).toHaveBeenCalledWith('/files/orderBookL2/20190401', { method: 'DELETE' });
  });

  it('appends ?suffix= to the path when suffix is non-empty', async () => {
    const vault = makeVault();

    vault.request.mockResolvedValue({ ok: true, status: 202 });

    await deleteFile(vault, 'orderBookL2', '20190401', 'tardy');

    expect(vault.request).toHaveBeenCalledWith('/files/orderBookL2/20190401?suffix=tardy', { method: 'DELETE' });
  });
});
