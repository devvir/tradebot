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

const VAULT  = 'http://vault:3000';
const TABLE  = 'trade' as const;
const DATE   = '20200101';
const SUFFIX = 'local';
const ROWS   = [{ action: 'insert', date: '2020-01-01T10:00:00.000Z', data: [] }];

// ── writeToVault ──────────────────────────────────────────────────────────────

describe('writeToVault', () => {
  it('returns "ok" on 202', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 202 } as Response);

    expect(await writeToVault(VAULT, TABLE, DATE, ROWS, SUFFIX)).toBe('ok');
  });

  it('returns "closed" on 409 (bucket sealed/closing) — one call, no retry', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 409 } as Response);

    expect(await writeToVault(VAULT, TABLE, DATE, ROWS, SUFFIX)).toBe('closed');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns "unavailable" on 503 — signals caller to retry', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok:      false,
      status:  503,
      text:    () => Promise.resolve('unhealthy'),
    } as unknown as Response);

    expect(await writeToVault(VAULT, TABLE, DATE, ROWS, SUFFIX)).toBe('unavailable');
  });

  it('returns "unavailable" on 429 (throttled) — signals caller to retry', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok:      false,
      status:  429,
      text:    () => Promise.resolve('too many inflight'),
    } as unknown as Response);

    expect(await writeToVault(VAULT, TABLE, DATE, ROWS, SUFFIX)).toBe('unavailable');
  });

  it('returns "unavailable" on 500 — signals caller to retry', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok:      false,
      status:  500,
      text:    () => Promise.resolve('internal error'),
    } as unknown as Response);

    expect(await writeToVault(VAULT, TABLE, DATE, ROWS, SUFFIX)).toBe('unavailable');
  });

  it('returns "unavailable" when fetch throws (network error)', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    expect(await writeToVault(VAULT, TABLE, DATE, ROWS, SUFFIX)).toBe('unavailable');
  });

  it('sends rows as JSON body to the suffixed URL', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 202 } as Response);

    await writeToVault(VAULT, TABLE, DATE, ROWS, SUFFIX);

    expect(global.fetch).toHaveBeenCalledWith(
      `${VAULT}/files/${TABLE}/${DATE}/rows?suffix=${SUFFIX}`,
      expect.objectContaining({
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(ROWS),
      }),
    );
  });

  it('omits the suffix query when suffix is empty', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 202 } as Response);

    await writeToVault(VAULT, TABLE, DATE, ROWS, '');

    expect(global.fetch).toHaveBeenCalledWith(
      `${VAULT}/files/${TABLE}/${DATE}/rows`,
      expect.anything(),
    );
  });
});

// ── closeVaultFile ────────────────────────────────────────────────────────────

describe('closeVaultFile', () => {
  it('resolves on 204', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 204 } as Response);

    await expect(closeVaultFile(VAULT, TABLE, DATE, SUFFIX)).resolves.toBeUndefined();
  });

  it('resolves on 404 (file already gone — idempotent)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 404 } as Response);

    await expect(closeVaultFile(VAULT, TABLE, DATE, SUFFIX)).resolves.toBeUndefined();
  });

  it('retries on 503 and eventually succeeds', async () => {
    vi.useFakeTimers();

    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce({ ok: true,  status: 204 } as Response);

    const done = closeVaultFile(VAULT, TABLE, DATE, SUFFIX);

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

    const done = closeVaultFile(VAULT, TABLE, DATE, SUFFIX);

    await vi.runAllTimersAsync();

    await done;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('sends a POST to the suffixed close URL', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 204 } as Response);

    await closeVaultFile(VAULT, TABLE, DATE, SUFFIX);

    expect(global.fetch).toHaveBeenCalledWith(
      `${VAULT}/files/${TABLE}/${DATE}/close?suffix=${SUFFIX}`,
      { method: 'POST' },
    );
  });
});
