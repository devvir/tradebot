import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStoreService } from '../src/vault';

const VAULT_URL = 'http://vault';

const okResponse = (status = 200): Response =>
  ({ ok: true, status, headers: new Headers() } as unknown as Response);

const errResponse = (status: number): Response =>
  ({ ok: false, status, headers: new Headers() } as unknown as Response);

const jsonResponse = (data: unknown): Response =>
  ({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(data) } as unknown as Response);

// ── writeRows ─────────────────────────────────────────────────────────────────

describe('StoreService — writeRows', () => {
  beforeEach(() => vi.spyOn(global, 'fetch'));
  afterEach(() => vi.restoreAllMocks());

  it('POSTs JSON rows to the correct endpoint', async () => {
    vi.mocked(global.fetch).mockResolvedValue(okResponse(202));

    await createStoreService(VAULT_URL).writeRows('funding', '20200101', [{ price: 100 }]);

    expect(global.fetch).toHaveBeenCalledWith(
      `${VAULT_URL}/files/funding/20200101/rows`,
      expect.objectContaining({
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify([{ price: 100 }]),
      }),
    );
  });

  it('throws when vault returns an error', async () => {
    vi.mocked(global.fetch).mockResolvedValue(errResponse(503));

    await expect(
      createStoreService(VAULT_URL).writeRows('funding', '20200101', []),
    ).rejects.toThrow('HTTP 503');
  });
});

// ── closeFile ─────────────────────────────────────────────────────────────────

describe('StoreService — closeFile', () => {
  beforeEach(() => vi.spyOn(global, 'fetch'));
  afterEach(() => vi.restoreAllMocks());

  it('POSTs to the close endpoint', async () => {
    vi.mocked(global.fetch).mockResolvedValue(okResponse(204));

    await createStoreService(VAULT_URL).closeFile('funding', '20200101');

    expect(global.fetch).toHaveBeenCalledWith(
      `${VAULT_URL}/files/funding/20200101/close`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('does not throw on 404 (file already gone)', async () => {
    vi.mocked(global.fetch).mockResolvedValue(errResponse(404));

    await expect(
      createStoreService(VAULT_URL).closeFile('funding', '20200101'),
    ).resolves.toBeUndefined();
  });

  it('throws on other errors', async () => {
    vi.mocked(global.fetch).mockResolvedValue(errResponse(500));

    await expect(
      createStoreService(VAULT_URL).closeFile('funding', '20200101'),
    ).rejects.toThrow('HTTP 500');
  });
});

// ── deleteFile ────────────────────────────────────────────────────────────────

describe('StoreService — deleteFile', () => {
  beforeEach(() => vi.spyOn(global, 'fetch'));
  afterEach(() => vi.restoreAllMocks());

  it('sends a DELETE request to the correct endpoint', async () => {
    vi.mocked(global.fetch).mockResolvedValue(okResponse(204));

    await createStoreService(VAULT_URL).deleteFile('funding', '20200101');

    expect(global.fetch).toHaveBeenCalledWith(
      `${VAULT_URL}/files/funding/20200101`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('does not throw on 404', async () => {
    vi.mocked(global.fetch).mockResolvedValue(errResponse(404));

    await expect(
      createStoreService(VAULT_URL).deleteFile('funding', '20200101'),
    ).resolves.toBeUndefined();
  });

  it('throws on other errors', async () => {
    vi.mocked(global.fetch).mockResolvedValue(errResponse(500));

    await expect(
      createStoreService(VAULT_URL).deleteFile('funding', '20200101'),
    ).rejects.toThrow('HTTP 500');
  });
});

// ── listFiles ─────────────────────────────────────────────────────────────────

describe('StoreService — listFiles', () => {
  beforeEach(() => vi.spyOn(global, 'fetch'));
  afterEach(() => vi.restoreAllMocks());

  it('returns the file listing from vault', async () => {
    const listing = { '20200101': 'closed', '20200102': 'open' };
    vi.mocked(global.fetch).mockResolvedValue(jsonResponse(listing));

    const result = await createStoreService(VAULT_URL).listFiles('funding');

    expect(result).toEqual(listing);
  });

  it('returns an empty object when vault returns 404', async () => {
    vi.mocked(global.fetch).mockResolvedValue(errResponse(404));

    const result = await createStoreService(VAULT_URL).listFiles('funding');

    expect(result).toEqual({});
  });

  it('throws on other errors', async () => {
    vi.mocked(global.fetch).mockResolvedValue(errResponse(500));

    await expect(
      createStoreService(VAULT_URL).listFiles('funding'),
    ).rejects.toThrow('HTTP 500');
  });
});
