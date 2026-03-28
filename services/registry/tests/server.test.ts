import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import { startServer } from '../src/server/index.js';

const mongoUrl = process.env['DB_URL']!;
const dataPath = join(tmpdir(), `registry-server-test-${process.pid}`);

mkdirSync(dataPath, { recursive: true });
process.env['REGISTRY_DATA_PATH'] = dataPath;

let client: MongoClient;
let db: Db;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  client = new MongoClient(mongoUrl);
  await client.connect();
  db = client.db('test_registry_server');

  server = startServer(db, { database: 'test_registry_server', httpPort: 0 });

  await new Promise<void>((resolve) => {
    server.once('listening', () => {
      const addr = server.address() as { port: number };

      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  await db.dropDatabase();
  await client.close();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const get = (path: string) => fetch(`${baseUrl}${path}`);

const post = (path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

// ── GET /symbols ──────────────────────────────────────────────────────────────

describe('GET /symbols', () => {
  it('returns an empty array initially', async () => {
    const res  = await get('/symbols');
    const body = await res.json() as unknown[];

    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });
});

// ── POST /symbols ─────────────────────────────────────────────────────────────

describe('POST /symbols', () => {
  it('registers a new symbol and returns id + symbol', async () => {
    const res  = await post('/symbols', { symbol: 'XBTUSD' });
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body['id']).toBe(0);
    expect(body['symbol']).toBe('XBTUSD');
  });

  it('is idempotent — returns the same id on re-registration', async () => {
    const res  = await post('/symbols', { symbol: 'XBTUSD' });
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body['id']).toBe(0);
  });

  it('assigns the next id to a new symbol', async () => {
    const res  = await post('/symbols', { symbol: 'ETHUSD' });
    const body = await res.json() as Record<string, unknown>;

    expect(body['id']).toBe(1);
  });

  it('returns 400 for an empty symbol', async () => {
    const res = await post('/symbols', { symbol: '' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when symbol field is missing', async () => {
    const res = await post('/symbols', {});

    expect(res.status).toBe(400);
  });
});

// ── GET /symbols (after inserts) ──────────────────────────────────────────────

describe('GET /symbols after inserts', () => {
  it('returns all registered symbols sorted by id', async () => {
    const res  = await get('/symbols');
    const body = await res.json() as Array<{ id: number; symbol: string }>;

    expect(res.status).toBe(200);
    expect(body.map((e) => e.symbol)).toContain('XBTUSD');
    expect(body.map((e) => e.symbol)).toContain('ETHUSD');
    expect(body[0]!.id).toBeLessThan(body[1]!.id);
  });
});

// ── POST /currencies ──────────────────────────────────────────────────────────

describe('POST /currencies', () => {
  it('registers a currency and returns id + currency', async () => {
    const res  = await post('/currencies', { currency: 'XBT' });
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body['id']).toBe(0);
    expect(body['currency']).toBe('XBT');
  });

  it('currency ids are independent from symbol ids', async () => {
    const res  = await post('/currencies', { currency: 'ETH' });
    const body = await res.json() as Record<string, unknown>;

    expect(body['id']).toBe(1);
  });

  it('returns 400 for missing currency field', async () => {
    const res = await post('/currencies', {});

    expect(res.status).toBe(400);
  });
});

// ── GET /currencies ───────────────────────────────────────────────────────────

describe('GET /currencies', () => {
  it('returns all registered currencies sorted by id', async () => {
    const res  = await get('/currencies');
    const body = await res.json() as Array<{ id: number; currency: string }>;

    expect(res.status).toBe(200);
    expect(body.length).toBeGreaterThanOrEqual(2);
    expect(body[0]!.id).toBeLessThan(body[1]!.id);
  });
});
