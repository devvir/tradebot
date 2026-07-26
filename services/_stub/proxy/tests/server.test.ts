import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { buildRouter } from '../src/server/routes';
import type { Config } from '../src/types';

const CONFIG: Config = {
  bouncerUrl:   'http://test-bouncer',
  bouncerToken: 'test-token',
};

const MOCK_ACCOUNT = {
  id:     'test-account',
  type:   'testnet' as const,
  apiKey: 'real-bitmex-key',
};

const MOCK_SIGN = {
  apiKey:    'real-bitmex-key',
  signature: 'abc123sig',
  expires:   1711234567,
};

const app = express().use(express.raw({ type: '*/*' })).use(buildRouter(CONFIG));

// ── Fetch mocking ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeJson<T>(data: T, status = 200): Response {
  return {
    ok:      status >= 200 && status < 300,
    status,
    json:    () => Promise.resolve(data),
    headers: { forEach: vi.fn() },
    body:    null,
  } as unknown as Response;
}

function makeUpstream(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Mock: account lookup then sign/rest then BitMEX. Used for cases 1 & 3. */
function mockAccountThenSignThenBitmex(upstreamStatus = 200, upstreamBody = '{"result":"ok"}'): ReturnType<typeof vi.fn> {
  return vi.fn()
    .mockResolvedValueOnce(makeJson(MOCK_ACCOUNT))
    .mockResolvedValueOnce(makeJson(MOCK_SIGN))
    .mockResolvedValueOnce(makeUpstream(upstreamBody, upstreamStatus));
}

/** Mock: accounts list then BitMEX response. Used for case 2. */
function mockAccountsListThenBitmex(upstreamStatus = 200, upstreamBody = '{"result":"ok"}'): ReturnType<typeof vi.fn> {
  return vi.fn()
    .mockResolvedValueOnce(makeJson([MOCK_ACCOUNT]))
    .mockResolvedValueOnce(makeUpstream(upstreamBody, upstreamStatus));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Proxy — case 1: x-account-id (sign via Bouncer)', () => {
  it('calls POST /sign/rest with account id from x-account-id', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await request(app).get('/order').set('x-account-id', 'test-account');

    const [url, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('http://test-bouncer/sign/rest');
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.accountId).toBe('test-account');
  });

  it('returns 401 when account is not found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeJson(null, 404)));

    const res = await request(app).get('/order').set('x-account-id', 'test-account');

    expect(res.status).toBe(401);
  });

  it('returns 503 when Bouncer throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('Bouncer responded 500 for account lookup')));

    const res = await request(app).get('/order').set('x-account-id', 'test-account');

    expect(res.status).toBe(503);
  });

  it('uses type from account to resolve BitMEX URL', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await request(app).get('/order?symbol=XBTUSD').set('x-account-id', 'test-account');

    const upstreamUrl = mockFetch.mock.calls[2]![0] as string;
    expect(upstreamUrl).toBe('https://testnet.bitmex.com/api/v1/order?symbol=XBTUSD');
  });

  it('attaches signed auth headers on forwarded request', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await request(app).get('/order').set('x-account-id', 'test-account');

    const [, opts] = mockFetch.mock.calls[2] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['api-key']).toBe(MOCK_SIGN.apiKey);
    expect(headers['api-expires']).toBe(String(MOCK_SIGN.expires));
    expect(headers['api-signature']).toBe(MOCK_SIGN.signature);
    expect(headers['x-account-id']).toBeUndefined();
  });
});

describe('Proxy — case 3: api-key only (account id, sign via Bouncer)', () => {
  it('uses api-key value as account id for signing', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await request(app).get('/order').set('api-key', 'test-account');

    const [, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.accountId).toBe('test-account');
  });

  it('forwards signed auth headers to BitMEX', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await request(app).get('/order').set('api-key', 'test-account');

    const [, opts] = mockFetch.mock.calls[2] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['api-key']).toBe(MOCK_SIGN.apiKey);
    expect(headers['api-signature']).toBe(MOCK_SIGN.signature);
  });
});

describe('Proxy — case 2: real credentials (api-key + api-signature)', () => {
  it('looks up account list from Bouncer to resolve URL (no sign endpoint called)', async () => {
    const mockFetch = mockAccountsListThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await request(app).get('/order')
      .set('api-key', 'real-bitmex-key')
      .set('api-signature', 'caller-precomputed-sig')
      .set('api-expires', '1711234567');

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test-bouncer/accounts');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns 401 when api-key does not match any account', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeJson([])));

    const res = await request(app).get('/order')
      .set('api-key', 'real-bitmex-key')
      .set('api-signature', 'caller-precomputed-sig')
      .set('api-expires', '1711234567');

    expect(res.status).toBe(401);
  });

  it('forwards caller api-key and api-signature unchanged', async () => {
    const mockFetch = mockAccountsListThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await request(app).get('/order')
      .set('api-key', 'real-bitmex-key')
      .set('api-signature', 'caller-precomputed-sig')
      .set('api-expires', '1711234567');

    const [, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['api-key']).toBe('real-bitmex-key');
    expect(headers['api-signature']).toBe('caller-precomputed-sig');
    expect(headers['api-expires']).toBe('1711234567');
  });

  it('uses account type from Bouncer to resolve BitMEX URL', async () => {
    const mockFetch = mockAccountsListThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await request(app).get('/position')
      .set('api-key', 'real-bitmex-key')
      .set('api-signature', 'caller-precomputed-sig')
      .set('api-expires', '1711234567');

    const upstreamUrl = mockFetch.mock.calls[1]![0] as string;
    expect(upstreamUrl).toBe('https://testnet.bitmex.com/api/v1/position');
  });

  it('returns 503 when Bouncer throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('Bouncer responded 500 listing accounts')));

    const res = await request(app).get('/order')
      .set('api-key', 'real-bitmex-key')
      .set('api-signature', 'caller-precomputed-sig')
      .set('api-expires', '1711234567');

    expect(res.status).toBe(503);
  });
});

describe('Proxy — response passthrough', () => {
  it('passes through BitMEX 200 response', async () => {
    vi.stubGlobal('fetch', mockAccountThenSignThenBitmex(200, '{"data":"ok"}'));

    const res = await request(app).get('/order').set('x-account-id', 'test-account');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: 'ok' });
  });

  it('passes through BitMEX 404 response unchanged', async () => {
    vi.stubGlobal('fetch', mockAccountThenSignThenBitmex(404, '{"error":"Not Found"}'));

    const res = await request(app).get('/order/doesnotexist').set('x-account-id', 'test-account');

    expect(res.status).toBe(404);
  });

  it('passes through query parameters', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await request(app).get('/order?symbol=XBTUSD&count=10').set('x-account-id', 'test-account');

    const upstreamUrl = mockFetch.mock.calls[2]![0] as string;
    expect(upstreamUrl).toContain('symbol=XBTUSD');
    expect(upstreamUrl).toContain('count=10');
  });

  it('does not forward x-account-id to BitMEX', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await request(app).get('/order').set('x-account-id', 'test-account');

    const [, opts] = mockFetch.mock.calls[2] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['x-account-id']).toBeUndefined();
  });

  it('forwards POST request body to BitMEX', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await request(app)
      .post('/order')
      .set('x-account-id', 'test-account')
      .set('content-type', 'application/json')
      .send('{"symbol":"XBTUSD","orderQty":100}');

    const [, opts] = mockFetch.mock.calls[2] as [string, RequestInit];
    expect(opts.method).toBe('POST');
    const sentBody = opts.body instanceof Buffer ? opts.body.toString() : String(opts.body ?? '');
    expect(sentBody).toBe('{"symbol":"XBTUSD","orderQty":100}');
  });

  it('includes request body in the signing payload', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await request(app)
      .post('/order')
      .set('x-account-id', 'test-account')
      .set('content-type', 'application/json')
      .send('{"symbol":"XBTUSD"}');

    const [, signOpts] = mockFetch.mock.calls[1] as [string, RequestInit];
    const signBody = JSON.parse(signOpts.body as string) as Record<string, unknown>;
    expect(signBody.body).toBe('{"symbol":"XBTUSD"}');
    expect(signBody.verb).toBe('POST');
  });

  it('includes BitMEX base path in signed path', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await request(app).get('/order').set('x-account-id', 'test-account');

    const [, signOpts] = mockFetch.mock.calls[1] as [string, RequestInit];
    const signBody = JSON.parse(signOpts.body as string) as Record<string, unknown>;
    expect(signBody.path).toBe('/api/v1/order');
  });

  it('forwards non-auth headers (e.g. content-type) to BitMEX', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await request(app)
      .post('/order')
      .set('x-account-id', 'test-account')
      .set('content-type', 'application/json')
      .set('accept', 'application/json')
      .send('{}');

    const [, opts] = mockFetch.mock.calls[2] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['accept']).toBe('application/json');
  });

  it('strips connection and transfer-encoding headers', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await request(app).get('/order')
      .set('x-account-id', 'test-account')
      .set('transfer-encoding', 'chunked');

    const [, opts] = mockFetch.mock.calls[2] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['transfer-encoding']).toBeUndefined();
  });

  it('preserves upstream response headers other than transport-layer ones', async () => {
    const upstreamRes = new Response('{"ok":true}', {
      status:  200,
      headers: {
        'content-type':           'application/json',
        'x-ratelimit-remaining':  '299',
        'x-bitmex-request-id':    'abc-123',
      },
    });

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(makeJson(MOCK_ACCOUNT))
      .mockResolvedValueOnce(makeJson(MOCK_SIGN))
      .mockResolvedValueOnce(upstreamRes),
    );

    const res = await request(app).get('/order').set('x-account-id', 'test-account');

    expect(res.headers['x-ratelimit-remaining']).toBe('299');
    expect(res.headers['x-bitmex-request-id']).toBe('abc-123');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

// ── x-testnet header ──────────────────────────────────────────────────────────

describe('Proxy — x-testnet (anonymous)', () => {
  it('defaults to live when no x-testnet header is set', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(makeUpstream('{"ok":true}'));
    vi.stubGlobal('fetch', mockFetch);

    await request(app).get('/instrument');

    const upstreamUrl = mockFetch.mock.calls[0]![0] as string;
    expect(upstreamUrl).toBe('https://www.bitmex.com/api/v1/instrument');
  });

  it('targets testnet when x-testnet: true', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(makeUpstream('{"ok":true}'));
    vi.stubGlobal('fetch', mockFetch);

    await request(app).get('/instrument').set('x-testnet', 'true');

    const upstreamUrl = mockFetch.mock.calls[0]![0] as string;
    expect(upstreamUrl).toBe('https://testnet.bitmex.com/api/v1/instrument');
  });

  it('targets live when x-testnet: false', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(makeUpstream('{"ok":true}'));
    vi.stubGlobal('fetch', mockFetch);

    await request(app).get('/instrument').set('x-testnet', 'false');

    const upstreamUrl = mockFetch.mock.calls[0]![0] as string;
    expect(upstreamUrl).toBe('https://www.bitmex.com/api/v1/instrument');
  });

  it('strips x-testnet from the upstream forward', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(makeUpstream('{"ok":true}'));
    vi.stubGlobal('fetch', mockFetch);

    await request(app).get('/instrument').set('x-testnet', 'true');

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['x-testnet']).toBeUndefined();
  });
});

describe('Proxy — x-testnet (mismatch with account env → 400)', () => {
  it('400s when x-account-id resolves to testnet but x-testnet: false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeJson(MOCK_ACCOUNT)));

    const res = await request(app).get('/order')
      .set('x-account-id', 'test-account')
      .set('x-testnet',    'false');

    expect(res.status).toBe(400);
  });

  it('passes through when x-account-id (testnet) matches x-testnet: true', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    const res = await request(app).get('/order')
      .set('x-account-id', 'test-account')
      .set('x-testnet',    'true');

    expect(res.status).toBe(200);
  });

  it('400s when real credentials resolve to testnet but x-testnet: false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeJson([MOCK_ACCOUNT])));

    const res = await request(app).get('/order')
      .set('api-key',       'real-bitmex-key')
      .set('api-signature', 'caller-precomputed-sig')
      .set('api-expires',   '1711234567')
      .set('x-testnet',     'false');

    expect(res.status).toBe(400);
  });
});
