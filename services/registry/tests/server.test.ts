import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { type Application, type ErrorRequestHandler } from 'express';
import { MongoClient, Db } from 'mongodb';
import request from 'supertest';
import { buildRouter } from '../src/server/routes.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn().mockResolvedValue(undefined) };
});

const mongoUrl = process.env['DB_URL']!;

// Minimal error handler — turns validateBody's `status`-carrying errors into
// responses, mirroring what the Net express server kind does in production.
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  res.status((err as { status?: number })?.status ?? 500)
     .json({ error: (err as Error)?.message ?? 'Error' });
};

let client: MongoClient;
let db: Db;
let app: Application;

beforeAll(async () => {
  client = new MongoClient(mongoUrl);
  await client.connect();
  db  = client.db('test_registry_server');
  app = express().use(express.json()).use(buildRouter(db)).use(errorHandler);
});

afterAll(async () => {
  await db.dropDatabase();
  await client.close();
});

// ── GET /symbols ──────────────────────────────────────────────────────────────

describe('GET /symbols', () => {
  it('returns an empty array initially', async () => {
    const res = await request(app).get('/symbols');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ── POST /symbols ─────────────────────────────────────────────────────────────

describe('POST /symbols', () => {
  it('registers a new symbol and returns id + symbol', async () => {
    const res = await request(app).post('/symbols').send({ symbol: 'XBTUSD' });

    expect(res.status).toBe(200);
    expect(res.body['id']).toBe(0);
    expect(res.body['symbol']).toBe('XBTUSD');
  });

  it('is idempotent — returns the same id on re-registration', async () => {
    const res = await request(app).post('/symbols').send({ symbol: 'XBTUSD' });

    expect(res.status).toBe(200);
    expect(res.body['id']).toBe(0);
  });

  it('assigns the next id to a new symbol', async () => {
    const res = await request(app).post('/symbols').send({ symbol: 'ETHUSD' });

    expect(res.body['id']).toBe(1);
  });

  it('returns 400 for an empty symbol', async () => {
    const res = await request(app).post('/symbols').send({ symbol: '' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when symbol field is missing', async () => {
    const res = await request(app).post('/symbols').send({});

    expect(res.status).toBe(400);
  });
});

// ── GET /symbols (after inserts) ──────────────────────────────────────────────

describe('GET /symbols after inserts', () => {
  it('returns all registered symbols sorted by id', async () => {
    const res  = await request(app).get('/symbols');
    const body = res.body as Array<{ id: number; symbol: string }>;

    expect(res.status).toBe(200);
    expect(body.map((e) => e.symbol)).toContain('XBTUSD');
    expect(body.map((e) => e.symbol)).toContain('ETHUSD');
    expect(body[0]!.id).toBeLessThan(body[1]!.id);
  });
});

// ── POST /currencies ──────────────────────────────────────────────────────────

describe('POST /currencies', () => {
  it('registers a currency and returns id + currency', async () => {
    const res = await request(app).post('/currencies').send({ currency: 'XBT' });

    expect(res.status).toBe(200);
    expect(res.body['id']).toBe(0);
    expect(res.body['currency']).toBe('XBT');
  });

  it('currency ids are independent from symbol ids', async () => {
    const res = await request(app).post('/currencies').send({ currency: 'ETH' });

    expect(res.body['id']).toBe(1);
  });

  it('returns 400 for missing currency field', async () => {
    const res = await request(app).post('/currencies').send({});

    expect(res.status).toBe(400);
  });
});

// ── GET /currencies ───────────────────────────────────────────────────────────

describe('GET /currencies', () => {
  it('returns all registered currencies sorted by id', async () => {
    const res  = await request(app).get('/currencies');
    const body = res.body as Array<{ id: number; currency: string }>;

    expect(res.status).toBe(200);
    expect(body.length).toBeGreaterThanOrEqual(2);
    expect(body[0]!.id).toBeLessThan(body[1]!.id);
  });
});
