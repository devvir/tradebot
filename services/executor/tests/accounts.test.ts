import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAccountRegistry } from '../src/accounts';
import type { Config } from '../src/types';

const CONFIG: Config = {
  bouncerUrl:   'http://bouncer',
  bouncerToken: 'test-token',
  httpPort:     3001,
};

const MOCK_BOUNCER_RESPONSE = {
  id:     'test-account',
  type:   'testnet' as const,
  apiKey: 'test-key',
};

function makeFetchResponse(data: unknown, status = 200): Response {
  return {
    ok:   status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  } as Response;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AccountRegistry', () => {
  it('fetches from bouncer on first get() with correct URL and auth header', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeFetchResponse(MOCK_BOUNCER_RESPONSE));

    vi.stubGlobal('fetch', mockFetch);

    const registry = createAccountRegistry(CONFIG);

    await registry.get('test-account');

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      'http://bouncer/accounts/test-account',
      { headers: { 'Authorization': 'Bearer test-token' } },
    );
  });

  it('returns cached data on second get() — fetch called only once', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeFetchResponse(MOCK_BOUNCER_RESPONSE));

    vi.stubGlobal('fetch', mockFetch);

    const registry = createAccountRegistry(CONFIG);

    const first  = await registry.get('test-account');
    const second = await registry.get('test-account');

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(first).toEqual(MOCK_BOUNCER_RESPONSE);
    expect(second).toEqual(MOCK_BOUNCER_RESPONSE);
  });

  it('caches different accounts independently', async () => {
    const otherBouncer  = { ...MOCK_BOUNCER_RESPONSE, id: 'other-account', apiKey: 'other-key' };
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeFetchResponse(MOCK_BOUNCER_RESPONSE))
      .mockResolvedValueOnce(makeFetchResponse(otherBouncer));

    vi.stubGlobal('fetch', mockFetch);

    const registry = createAccountRegistry(CONFIG);

    const first  = await registry.get('test-account');
    const second = await registry.get('other-account');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(first.apiKey).toBe('test-key');
    expect(second.apiKey).toBe('other-key');

    // Second call to each should hit cache, not fetch
    await registry.get('test-account');
    await registry.get('other-account');

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws on non-ok response (status 404)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeFetchResponse(null, 404));

    vi.stubGlobal('fetch', mockFetch);

    const registry = createAccountRegistry(CONFIG);

    await expect(registry.get('missing-account')).rejects.toThrow('404');
  });
});
