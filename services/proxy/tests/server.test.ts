import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http, { type Server } from 'node:http';
import { startServer } from '../src/server';
import type { Config } from '../src/types';

const CONFIG: Config = {
  bouncerUrl:   'http://test-bouncer',
  bouncerToken: 'test-token',
  httpPort:      0,
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

// ── Server lifecycle ──────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = startServer(CONFIG);

  await new Promise<void>((resolve) => {
    server.once('listening', () => {
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

// ── Fetch mocking ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

interface TestResponse {
  status: number;
  json:   () => Promise<unknown>;
}

function httpRequest(
  method:  string,
  path:    string,
  headers: Record<string, string> = {},
  body?:   string,
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const reqHeaders: Record<string, string> = { ...headers };
    if (body) reqHeaders['content-length'] = String(Buffer.byteLength(body));

    const req = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers: reqHeaders },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, json: () => Promise.resolve(JSON.parse(data)) }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Request with x-account-id (case 1). */
function withAccountId(path: string, opts: { method?: string; body?: string } = {}): Promise<TestResponse> {
  return httpRequest(opts.method ?? 'GET', path, { 'x-account-id': 'test-account' }, opts.body);
}

/** Request with api-key only — account id flow (case 3). */
function withApiKeyOnly(path: string): Promise<TestResponse> {
  return httpRequest('GET', path, { 'api-key': 'test-account' });
}

/** Request with real credentials: api-key is real BitMEX apiKey + pre-computed signature (case 2). */
function withRealCredentials(path: string): Promise<TestResponse> {
  return httpRequest('GET', path, {
    'api-key':       'real-bitmex-key',
    'api-signature': 'caller-precomputed-sig',
    'api-expires':   '1711234567',
  });
}

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

    await withAccountId('/order');

    const [url, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('http://test-bouncer/sign/rest');
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.accountId).toBe('test-account');
  });

  it('returns 401 when account is not found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeJson(null, 404)));
    const res = await withAccountId('/order');
    expect(res.status).toBe(401);
  });

  it('returns 503 when Bouncer throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('Bouncer responded 500 for account lookup')));
    const res = await withAccountId('/order');
    expect(res.status).toBe(503);
  });

  it('uses type from account to resolve BitMEX URL', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await withAccountId('/order?symbol=XBTUSD');

    const upstreamUrl = mockFetch.mock.calls[2]![0] as string;
    expect(upstreamUrl).toBe('https://testnet.bitmex.com/api/v1/order?symbol=XBTUSD');
  });

  it('attaches signed auth headers on forwarded request', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await withAccountId('/order');

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

    await withApiKeyOnly('/order');

    const [, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.accountId).toBe('test-account');
  });

  it('forwards signed auth headers to BitMEX', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await withApiKeyOnly('/order');

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

    await withRealCredentials('/order');

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test-bouncer/accounts');
    // Only two calls: accounts list + BitMEX (no sign/rest)
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns 401 when api-key does not match any account', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeJson([])));
    const res = await withRealCredentials('/order');
    expect(res.status).toBe(401);
  });

  it('forwards caller api-key and api-signature unchanged', async () => {
    const mockFetch = mockAccountsListThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await withRealCredentials('/order');

    const [, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['api-key']).toBe('real-bitmex-key');
    expect(headers['api-signature']).toBe('caller-precomputed-sig');
    expect(headers['api-expires']).toBe('1711234567');
  });

  it('uses account type from Bouncer to resolve BitMEX URL', async () => {
    const mockFetch = mockAccountsListThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await withRealCredentials('/position');

    const upstreamUrl = mockFetch.mock.calls[1]![0] as string;
    expect(upstreamUrl).toBe('https://testnet.bitmex.com/api/v1/position');
  });

  it('returns 503 when Bouncer throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('Bouncer responded 500 listing accounts')));
    const res = await withRealCredentials('/order');
    expect(res.status).toBe(503);
  });
});

describe('Proxy — response passthrough', () => {
  it('passes through BitMEX 200 response', async () => {
    vi.stubGlobal('fetch', mockAccountThenSignThenBitmex(200, '{"data":"ok"}'));
    const res = await withAccountId('/order');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: 'ok' });
  });

  it('passes through BitMEX 404 response unchanged', async () => {
    vi.stubGlobal('fetch', mockAccountThenSignThenBitmex(404, '{"error":"Not Found"}'));
    const res = await withAccountId('/order/doesnotexist');
    expect(res.status).toBe(404);
  });

  it('passes through query parameters', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);
    await withAccountId('/order?symbol=XBTUSD&count=10');
    const upstreamUrl = mockFetch.mock.calls[2]![0] as string;
    expect(upstreamUrl).toContain('symbol=XBTUSD');
    expect(upstreamUrl).toContain('count=10');
  });

  it('does not forward x-account-id to BitMEX', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);
    await withAccountId('/order');
    const [, opts] = mockFetch.mock.calls[2] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['x-account-id']).toBeUndefined();
  });

  it('forwards POST request body to BitMEX', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);
    const body = '{"symbol":"XBTUSD","orderQty":100}';
    await httpRequest('POST', '/order', {
      'x-account-id': 'test-account',
      'content-type': 'application/json',
    }, body);

    const [, opts] = mockFetch.mock.calls[2] as [string, RequestInit];
    expect(opts.method).toBe('POST');
    const sentBody = opts.body instanceof Buffer ? opts.body.toString() : String(opts.body ?? '');
    expect(sentBody).toBe(body);
  });

  it('includes request body in the signing payload', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);
    const body = '{"symbol":"XBTUSD"}';
    await httpRequest('POST', '/order', {
      'x-account-id': 'test-account',
      'content-type': 'application/json',
    }, body);

    const [, signOpts] = mockFetch.mock.calls[1] as [string, RequestInit];
    const signBody = JSON.parse(signOpts.body as string) as Record<string, unknown>;
    expect(signBody.body).toBe(body);
    expect(signBody.verb).toBe('POST');
  });

  it('includes BitMEX base path in signed path', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);
    await withAccountId('/order');

    const [, signOpts] = mockFetch.mock.calls[1] as [string, RequestInit];
    const signBody = JSON.parse(signOpts.body as string) as Record<string, unknown>;
    expect(signBody.path).toBe('/api/v1/order');
  });

  it('forwards non-auth headers (e.g. content-type) to BitMEX', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await httpRequest('POST', '/order', {
      'x-account-id': 'test-account',
      'content-type': 'application/json',
      'accept':       'application/json',
    }, '{}');

    const [, opts] = mockFetch.mock.calls[2] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['accept']).toBe('application/json');
  });

  it('strips connection and transfer-encoding headers', async () => {
    const mockFetch = mockAccountThenSignThenBitmex();
    vi.stubGlobal('fetch', mockFetch);

    await httpRequest('GET', '/order', {
      'x-account-id':    'test-account',
      'transfer-encoding': 'chunked',
    });

    const [, opts] = mockFetch.mock.calls[2] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['transfer-encoding']).toBeUndefined();
  });
});


