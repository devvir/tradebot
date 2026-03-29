import { describe, it, expect, vi, beforeEach } from 'vitest';

// Re-import the module fresh before each test so module-level singletons
// (vaultDown, recoveryGate) are reset between test cases.
let writeToVault:   typeof import('../src/persistence/vault').writeToVault;
let closeVaultFile: typeof import('../src/persistence/vault').closeVaultFile;

beforeEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();
  ({ writeToVault, closeVaultFile } = await import('../src/persistence/vault'));
});

const VAULT = 'http://vault:3000';
const TABLE = 'trade' as const;
const DATE  = '20200101';
const ROWS  = [{ action: 'insert', date: '2020-01-01T10:00:00.000Z', data: [] }];

// ── writeToVault ──────────────────────────────────────────────────────────────

describe('writeToVault', () => {
  it('returns true on 202', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 202 } as Response);

    expect(await writeToVault(VAULT, TABLE, DATE, ROWS)).toBe(true);
  });

  it('returns true on 409 (file closing) — drops without retry', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 409 } as Response);

    expect(await writeToVault(VAULT, TABLE, DATE, ROWS)).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns true on 418 (file sealed) — drops without retry', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 418 } as Response);

    expect(await writeToVault(VAULT, TABLE, DATE, ROWS)).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns false on 503 — signals caller to retry', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok:      false,
      status:  503,
      text:    () => Promise.resolve('unhealthy'),
    } as unknown as Response);

    expect(await writeToVault(VAULT, TABLE, DATE, ROWS)).toBe(false);
  });

  it('returns false on 500 — signals caller to retry', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok:      false,
      status:  500,
      text:    () => Promise.resolve('internal error'),
    } as unknown as Response);

    expect(await writeToVault(VAULT, TABLE, DATE, ROWS)).toBe(false);
  });

  it('returns false when fetch throws (network error)', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    expect(await writeToVault(VAULT, TABLE, DATE, ROWS)).toBe(false);
  });

  it('only makes one fetch call for 409 (no retry loop)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 409 } as Response);

    await writeToVault(VAULT, TABLE, DATE, ROWS);

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('only makes one fetch call for 418 (no retry loop)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 418 } as Response);

    await writeToVault(VAULT, TABLE, DATE, ROWS);

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('sends rows as JSON body to the correct URL', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 202 } as Response);

    await writeToVault(VAULT, TABLE, DATE, ROWS);

    expect(global.fetch).toHaveBeenCalledWith(
      `${VAULT}/files/${TABLE}/${DATE}/rows`,
      expect.objectContaining({
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(ROWS),
      }),
    );
  });
});

// ── closeVaultFile ────────────────────────────────────────────────────────────

describe('closeVaultFile', () => {
  it('resolves on 204', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 204 } as Response);

    await expect(closeVaultFile(VAULT, TABLE, DATE)).resolves.toBeUndefined();
  });

  it('resolves on 404 (file already gone — idempotent)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 404 } as Response);

    await expect(closeVaultFile(VAULT, TABLE, DATE)).resolves.toBeUndefined();
  });

  it('retries on 503 and eventually succeeds', async () => {
    vi.useFakeTimers();

    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce({ ok: true,  status: 204 } as Response);

    const done = closeVaultFile(VAULT, TABLE, DATE);

    // Let the first fetch call complete, then advance past waitForVault's 5s pause.
    await vi.runAllTimersAsync();

    await done;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('retries on network error and eventually succeeds', async () => {
    vi.useFakeTimers();

    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true, status: 204 } as Response);

    const done = closeVaultFile(VAULT, TABLE, DATE);

    await vi.runAllTimersAsync();

    await done;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('sends a POST to the correct close URL', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 204 } as Response);

    await closeVaultFile(VAULT, TABLE, DATE);

    expect(global.fetch).toHaveBeenCalledWith(
      `${VAULT}/files/${TABLE}/${DATE}/close`,
      { method: 'POST' },
    );
  });
});
