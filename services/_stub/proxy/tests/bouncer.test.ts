import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAccount, getAccountByApiKey, signRest } from '../src/bouncer';

const BOUNCER_URL   = 'http://test-bouncer';
const BOUNCER_TOKEN = 'test-token';

const ACCOUNT = { id: 'acc-1', type: 'testnet' as const, apiKey: 'key-abc' };

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { vi.unstubAllGlobals(); });

// ── getAccount ────────────────────────────────────────────────────────────────

describe('getAccount', () => {
  it('returns account on 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, json: () => Promise.resolve(ACCOUNT),
    }));

    const result = await getAccount(BOUNCER_URL, BOUNCER_TOKEN, 'acc-1');
    expect(result).toEqual(ACCOUNT);
  });

  it('sends Authorization header', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, json: () => Promise.resolve(ACCOUNT),
    });
    vi.stubGlobal('fetch', mockFetch);

    await getAccount(BOUNCER_URL, BOUNCER_TOKEN, 'acc-1');
    expect(mockFetch.mock.calls[0]![1]).toEqual({ headers: { Authorization: 'Bearer test-token' } });
  });

  it('returns null on 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 404 }));

    const result = await getAccount(BOUNCER_URL, BOUNCER_TOKEN, 'missing');
    expect(result).toBeNull();
  });

  it('throws on non-404 error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 500 }));

    await expect(getAccount(BOUNCER_URL, BOUNCER_TOKEN, 'err')).rejects.toThrow(
      'Bouncer responded 500 for account lookup',
    );
  });
});

// ── getAccountByApiKey ────────────────────────────────────────────────────────

describe('getAccountByApiKey', () => {
  it('finds matching account by apiKey', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, json: () => Promise.resolve([ACCOUNT, { id: 'acc-2', type: 'live', apiKey: 'other' }]),
    }));

    const result = await getAccountByApiKey(BOUNCER_URL, BOUNCER_TOKEN, 'key-abc');
    expect(result).toEqual(ACCOUNT);
  });

  it('returns null when no account matches', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, json: () => Promise.resolve([ACCOUNT]),
    }));

    const result = await getAccountByApiKey(BOUNCER_URL, BOUNCER_TOKEN, 'unknown-key');
    expect(result).toBeNull();
  });

  it('throws when Bouncer returns an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }));

    await expect(getAccountByApiKey(BOUNCER_URL, BOUNCER_TOKEN, 'key-abc')).rejects.toThrow(
      'Bouncer responded 503 listing accounts',
    );
  });
});

// ── signRest ──────────────────────────────────────────────────────────────────

describe('signRest', () => {
  const SIGN_RESULT = { apiKey: 'key-abc', signature: 'sig-xyz', expires: 1711234567 };

  it('returns signed result on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, json: () => Promise.resolve(SIGN_RESULT),
    }));

    const result = await signRest(BOUNCER_URL, BOUNCER_TOKEN, 'acc-1', 'GET', '/api/v1/order', 1711234567, '');
    expect(result).toEqual(SIGN_RESULT);
  });

  it('sends correct payload', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, json: () => Promise.resolve(SIGN_RESULT),
    });
    vi.stubGlobal('fetch', mockFetch);

    await signRest(BOUNCER_URL, BOUNCER_TOKEN, 'acc-1', 'POST', '/api/v1/order', 1711234567, '{"symbol":"XBTUSD"}');

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test-bouncer/sign/rest');
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      accountId: 'acc-1',
      verb:     'POST',
      path:     '/api/v1/order',
      expires:  1711234567,
      body:     '{"symbol":"XBTUSD"}',
    });
  });

  it('throws when Bouncer returns an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 400 }));

    await expect(
      signRest(BOUNCER_URL, BOUNCER_TOKEN, 'acc-1', 'GET', '/api/v1/order', 1711234567, ''),
    ).rejects.toThrow('Bouncer responded 400 when signing request');
  });
});
