import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import http from 'node:http';
import { startServer } from '../src/server';

const TOKEN     = 'test-token';
const DATA_PATH = join(tmpdir(), `bouncer-server-test-${process.pid}.json`);

const TEST_ACCOUNT = {
  id:        'test-account',
  type:      'testnet',
  apiKey:    'test-api-key',
  apiSecret: 'test-api-secret',
};

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = startServer({ token: TOKEN, dataPath: DATA_PATH });

  await new Promise<void>((resolve) => {
    server.once('listening', () => {
      const addr = server.address() as { port: number };

      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });

  await post('/accounts', TEST_ACCOUNT);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  if (existsSync(DATA_PATH)) {
    rmSync(DATA_PATH);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

function authed(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: { 'Authorization': `Bearer ${TOKEN}` },
  });
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });
}

function del(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method:  'DELETE',
    headers: { 'Authorization': `Bearer ${TOKEN}` },
  });
}

function hmac(secret: string, msg: string): string {
  return createHmac('sha256', secret).update(msg).digest('hex');
}

// ── Authentication ────────────────────────────────────────────────────────────

describe('authentication', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await get('/accounts');

    expect(res.status).toBe(401);
  });

  it('returns 401 when token is wrong', async () => {
    const res = await fetch(`${baseUrl}/accounts`, {
      headers: { 'Authorization': 'Bearer wrong-token' },
    });

    expect(res.status).toBe(401);
  });

  it('returns 200 with correct token', async () => {
    const res = await authed('/accounts');

    expect(res.status).toBe(200);
  });
});

// ── POST /accounts ────────────────────────────────────────────────────────────

describe('POST /accounts', () => {
  it('returns 201 and summary without apiSecret', async () => {
    const account = {
      id:        'new-account',
      type:      'live',
      apiKey:    'live-key',
      apiSecret: 'live-secret',
    };

    const res  = await post('/accounts', account);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(201);
    expect(body['id']).toBe('new-account');
    expect(body).not.toHaveProperty('apiSecret');
  });

  it('returns 409 for duplicate id', async () => {
    const res = await post('/accounts', TEST_ACCOUNT);

    expect(res.status).toBe(409);
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await post('/accounts', { id: 'incomplete' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when type is invalid', async () => {
    const res = await post('/accounts', { ...TEST_ACCOUNT, id: 'bad-type', type: 'invalid' });

    expect(res.status).toBe(400);
  });
});

// ── GET /accounts ─────────────────────────────────────────────────────────────

describe('GET /accounts', () => {
  it('returns an array', async () => {
    const res  = await authed('/accounts');
    const body = await res.json() as unknown[];

    expect(res.status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it('does not include apiSecret', async () => {
    const res  = await authed('/accounts');
    const body = await res.json() as Record<string, unknown>[];

    for (const account of body) {
      expect(account).not.toHaveProperty('apiSecret');
    }
  });
});

// ── GET /accounts/:id ─────────────────────────────────────────────────────────

describe('GET /accounts/:id', () => {
  it('returns 200 with summary (no apiSecret)', async () => {
    const res  = await authed('/accounts/test-account');
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body['id']).toBe('test-account');
    expect(body).not.toHaveProperty('apiSecret');
  });

  it('returns 404 for unknown id', async () => {
    const res = await authed('/accounts/does-not-exist');

    expect(res.status).toBe(404);
  });
});

// ── GET /accounts/:id?expires ─────────────────────────────────────────────────

describe('GET /accounts/:id?expires', () => {
  it('includes apiKey, signature, and expires in response', async () => {
    const expires = Math.floor(Date.now() / 1000) + 60;
    const res     = await authed(`/accounts/test-account?expires=${expires}`);
    const body    = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body['apiKey']).toBe('test-api-key');
    expect(body['expires']).toBe(expires);
    expect(typeof body['signature']).toBe('string');
  });

  it('signature matches HMAC-SHA256(secret, GET/realtime + expires)', async () => {
    const expires   = Math.floor(Date.now() / 1000) + 60;
    const res       = await authed(`/accounts/test-account?expires=${expires}`);
    const body      = await res.json() as Record<string, unknown>;
    const expected  = hmac(TEST_ACCOUNT.apiSecret, `GET/realtime${expires}`);

    expect(body['signature']).toBe(expected);
  });
});

// ── DELETE /accounts/:id ──────────────────────────────────────────────────────

describe('DELETE /accounts/:id', () => {
  it('returns 204', async () => {
    const res = await del('/accounts/new-account');

    expect(res.status).toBe(204);
  });

  it('is idempotent — 204 again for same id', async () => {
    const res = await del('/accounts/new-account');

    expect(res.status).toBe(204);
  });
});

// ── POST /sign/ws ─────────────────────────────────────────────────────────────

describe('POST /sign/ws', () => {
  it('returns 200 with apiKey, signature, and expires', async () => {
    const expires = Math.floor(Date.now() / 1000) + 60;
    const res     = await post('/sign/ws', { accountId: 'test-account', expires });
    const body    = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body['apiKey']).toBe('test-api-key');
    expect(typeof body['signature']).toBe('string');
    expect(body['expires']).toBe(expires);
  });

  it('signature is HMAC-SHA256(secret, GET/realtime + expires)', async () => {
    const expires  = Math.floor(Date.now() / 1000) + 60;
    const res      = await post('/sign/ws', { accountId: 'test-account', expires });
    const body     = await res.json() as Record<string, unknown>;
    const expected = hmac(TEST_ACCOUNT.apiSecret, `GET/realtime${expires}`);

    expect(body['signature']).toBe(expected);
  });

  it('returns 404 for unknown account', async () => {
    const res = await post('/sign/ws', { accountId: 'unknown', expires: 9999999999 });

    expect(res.status).toBe(404);
  });

  it('returns 400 on validation failure', async () => {
    const res = await post('/sign/ws', { accountId: 'test-account' });

    expect(res.status).toBe(400);
  });
});

// ── POST /sign/rest ───────────────────────────────────────────────────────────

describe('POST /sign/rest', () => {
  it('returns 200 with apiKey, signature, and expires', async () => {
    const expires = Math.floor(Date.now() / 1000) + 60;
    const res     = await post('/sign/rest', {
      accountId: 'test-account',
      verb:      'POST',
      path:      '/api/v1/order',
      expires,
      body:      '{"symbol":"XBTUSD"}',
    });
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body['apiKey']).toBe('test-api-key');
    expect(typeof body['signature']).toBe('string');
    expect(body['expires']).toBe(expires);
  });

  it('signature is HMAC-SHA256(secret, verb + path + expires + body)', async () => {
    const expires  = Math.floor(Date.now() / 1000) + 60;
    const verb     = 'POST';
    const path     = '/api/v1/order';
    const reqBody  = '{"symbol":"XBTUSD"}';
    const res      = await post('/sign/rest', { accountId: 'test-account', verb, path, expires, body: reqBody });
    const body     = await res.json() as Record<string, unknown>;
    const expected = hmac(TEST_ACCOUNT.apiSecret, `${verb}${path}${expires}${reqBody}`);

    expect(body['signature']).toBe(expected);
  });

  it('returns 404 for unknown account', async () => {
    const res = await post('/sign/rest', {
      accountId: 'unknown',
      verb:      'GET',
      path:      '/api/v1/order',
      expires:   9999999999,
    });

    expect(res.status).toBe(404);
  });

  it('returns 400 on validation failure', async () => {
    const res = await post('/sign/rest', { accountId: 'test-account' });

    expect(res.status).toBe(400);
  });
});

// ── Error handler ─────────────────────────────────────────────────────────────

describe('error handler', () => {
  it('returns 400 with meaningful message on Zod validation failure', async () => {
    const res  = await post('/accounts', { id: '', type: 'live' });
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(typeof body['error']).toBe('string');
    expect((body['error'] as string).length).toBeGreaterThan(0);
  });
});
