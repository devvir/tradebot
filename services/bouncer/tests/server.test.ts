import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import request from 'supertest';
import { createApp } from '../src/server';

const TOKEN     = 'test-token';
const DATA_PATH = join(tmpdir(), `bouncer-server-test-${process.pid}.json`);

const TEST_ACCOUNT = {
  id:        'test-account',
  type:      'testnet',
  apiKey:    'test-api-key',
  apiSecret: 'test-api-secret',
};

const app = createApp({ token: TOKEN, dataPath: DATA_PATH });

beforeAll(async () => {
  await post('/accounts', TEST_ACCOUNT);
});

afterAll(() => {
  if (existsSync(DATA_PATH)) {
    rmSync(DATA_PATH);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function get(path: string) {
  return request(app).get(path);
}

function authed(path: string) {
  return request(app).get(path).set('Authorization', `Bearer ${TOKEN}`);
}

function post(path: string, body: unknown) {
  return request(app)
    .post(path)
    .set('Authorization', `Bearer ${TOKEN}`)
    .set('Content-Type', 'application/json')
    .send(body);
}

function del(path: string) {
  return request(app).delete(path).set('Authorization', `Bearer ${TOKEN}`);
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
    const res = await request(app).get('/accounts').set('Authorization', 'Bearer wrong-token');

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

    const res = await post('/accounts', account);

    expect(res.status).toBe(201);
    expect(res.body['id']).toBe('new-account');
    expect(res.body).not.toHaveProperty('apiSecret');
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
    const res = await authed('/accounts');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('does not include apiSecret', async () => {
    const res = await authed('/accounts');

    for (const account of res.body as Record<string, unknown>[]) {
      expect(account).not.toHaveProperty('apiSecret');
    }
  });
});

// ── GET /accounts/:id ─────────────────────────────────────────────────────────

describe('GET /accounts/:id', () => {
  it('returns 200 with summary (no apiSecret)', async () => {
    const res = await authed('/accounts/test-account');

    expect(res.status).toBe(200);
    expect(res.body['id']).toBe('test-account');
    expect(res.body).not.toHaveProperty('apiSecret');
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

    expect(res.status).toBe(200);
    expect(res.body['apiKey']).toBe('test-api-key');
    expect(res.body['expires']).toBe(expires);
    expect(typeof res.body['signature']).toBe('string');
  });

  it('signature matches HMAC-SHA256(secret, GET/realtime + expires)', async () => {
    const expires  = Math.floor(Date.now() / 1000) + 60;
    const res      = await authed(`/accounts/test-account?expires=${expires}`);
    const expected = hmac(TEST_ACCOUNT.apiSecret, `GET/realtime${expires}`);

    expect(res.body['signature']).toBe(expected);
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

    expect(res.status).toBe(200);
    expect(res.body['apiKey']).toBe('test-api-key');
    expect(typeof res.body['signature']).toBe('string');
    expect(res.body['expires']).toBe(expires);
  });

  it('signature is HMAC-SHA256(secret, GET/realtime + expires)', async () => {
    const expires  = Math.floor(Date.now() / 1000) + 60;
    const res      = await post('/sign/ws', { accountId: 'test-account', expires });
    const expected = hmac(TEST_ACCOUNT.apiSecret, `GET/realtime${expires}`);

    expect(res.body['signature']).toBe(expected);
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

    expect(res.status).toBe(200);
    expect(res.body['apiKey']).toBe('test-api-key');
    expect(typeof res.body['signature']).toBe('string');
    expect(res.body['expires']).toBe(expires);
  });

  it('signature is HMAC-SHA256(secret, verb + path + expires + body)', async () => {
    const expires  = Math.floor(Date.now() / 1000) + 60;
    const verb     = 'POST';
    const path     = '/api/v1/order';
    const reqBody  = '{"symbol":"XBTUSD"}';
    const res      = await post('/sign/rest', { accountId: 'test-account', verb, path, expires, body: reqBody });
    const expected = hmac(TEST_ACCOUNT.apiSecret, `${verb}${path}${expires}${reqBody}`);

    expect(res.body['signature']).toBe(expected);
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
    const res = await post('/accounts', { id: '', type: 'live' });

    expect(res.status).toBe(400);
    expect(typeof res.body['error']).toBe('string');
    expect((res.body['error'] as string).length).toBeGreaterThan(0);
  });
});
