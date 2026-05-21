import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Application, type ErrorRequestHandler } from 'express';
import request from 'supertest';
import type { Db } from 'mongodb';
import { buildRouter, type InsertCounter } from '../src/server';
import type { Config } from '../src/types';

// ── App assembly ──────────────────────────────────────────────────────────────

// Error handler mirroring the Net express server kind: oversize bodies → 413.
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if ((err as { type?: string })?.type === 'entity.too.large') {
    res.status(413).json({ error: 'request body too large' });

    return;
  }

  res.status((err as { status?: number })?.status ?? 500)
     .json({ error: (err as Error)?.message ?? 'error' });
};

const makeApp = (db: Db, config: Config, counter: InsertCounter): Application =>
  express()
    .use(express.json({ limit: '32mb' }))
    .use(buildRouter(db, config, counter))
    .use(errorHandler);

// ── Mongo mock ────────────────────────────────────────────────────────────────

interface MockCollection {
  insertMany: ReturnType<typeof vi.fn>;
}

const makeDb = (insertImpl: (docs: unknown[]) => Promise<unknown>): { db: Db; collection: MockCollection; collectionSpy: ReturnType<typeof vi.fn> } => {
  const collection: MockCollection = { insertMany: vi.fn(insertImpl) };
  const collectionSpy              = vi.fn(() => collection);
  const db                         = { collection: collectionSpy } as unknown as Db;

  return { db, collection, collectionSpy };
};

const config: Config = {
  database:         'speed_test',
  ignoreDuplicates: true,
};

let counter: ReturnType<typeof vi.fn>;

beforeEach(() => {
  counter = vi.fn();
});

// ── Health ────────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with { ok: true }', async () => {
    const { db } = makeDb(async () => ({ insertedCount: 0 }));
    const app    = makeApp(db, config, counter);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

// ── POST /write/:table — happy path ───────────────────────────────────────────

describe('POST /write/:table — happy path', () => {
  it('routes to the right collection and returns inserted count', async () => {
    const { db, collection, collectionSpy } = makeDb(async () => ({ insertedCount: 3 }));
    const app = makeApp(db, config, counter);

    const docs = [{ _id: 1, a: 1 }, { _id: 2, a: 2 }, { _id: 3, a: 3 }];

    const res = await request(app)
      .post('/write/trade')
      .set('Content-Type', 'application/json')
      .send(docs);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ inserted: 3 });
    expect(collectionSpy).toHaveBeenCalledWith('trade');
    expect(collection.insertMany).toHaveBeenCalledWith(docs, { ordered: false });
    expect(counter).toHaveBeenCalledWith(3);
  });

  it('uses ordered: false so partial batches still insert', async () => {
    const { db, collection } = makeDb(async () => ({ insertedCount: 1 }));
    const app                = makeApp(db, config, counter);

    await request(app)
      .post('/write/quote')
      .set('Content-Type', 'application/json')
      .send([{ _id: 1, x: 'y' }]);

    expect(collection.insertMany.mock.calls[0]![1]).toEqual({ ordered: false });
  });
});

// ── POST /write/:table — bad input ────────────────────────────────────────────

describe('POST /write/:table — input validation', () => {
  it('returns 400 when body is not an array', async () => {
    const { db, collection } = makeDb(async () => ({ insertedCount: 0 }));
    const app                = makeApp(db, config, counter);

    const res = await request(app)
      .post('/write/trade')
      .set('Content-Type', 'application/json')
      .send({ not: 'an array' });

    expect(res.status).toBe(400);
    expect(collection.insertMany).not.toHaveBeenCalled();
    expect(counter).not.toHaveBeenCalled();
  });

  it('returns 400 when body is an empty array', async () => {
    const { db, collection } = makeDb(async () => ({ insertedCount: 0 }));
    const app                = makeApp(db, config, counter);

    const res = await request(app)
      .post('/write/trade')
      .set('Content-Type', 'application/json')
      .send([]);

    expect(res.status).toBe(400);
    expect(collection.insertMany).not.toHaveBeenCalled();
  });
});

// ── POST /write/:table — duplicate key behavior ───────────────────────────────

describe('POST /write/:table — duplicate key (E11000)', () => {
  const dupError = (insertedCount: number) => Object.assign(new Error('E11000'), { code: 11000, result: { insertedCount } });

  it('returns 200 with duplicates: true when ignoreDuplicates is on', async () => {
    const { db } = makeDb(async () => { throw dupError(2); });
    const app    = makeApp(db, { ...config, ignoreDuplicates: true }, counter);

    const res = await request(app)
      .post('/write/trade')
      .set('Content-Type', 'application/json')
      .send([{ _id: 1 }, { _id: 2 }, { _id: 3 }]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ inserted: 2, duplicates: true });
    expect(counter).toHaveBeenCalledWith(2);
  });

  it('returns 409 when ignoreDuplicates is off, reporting partial inserts', async () => {
    const { db } = makeDb(async () => { throw dupError(2); });
    const app    = makeApp(db, { ...config, ignoreDuplicates: false }, counter);

    const res = await request(app)
      .post('/write/trade')
      .set('Content-Type', 'application/json')
      .send([{ _id: 1 }, { _id: 2 }, { _id: 3 }]);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ inserted: 2, error: 'duplicate key' });
    expect(counter).toHaveBeenCalledWith(2);
  });
});

// ── POST /write/:table — mongo errors ─────────────────────────────────────────

describe('POST /write/:table — mongo error', () => {
  it('returns 500 with the error message when insertMany rejects', async () => {
    const { db } = makeDb(async () => { throw new Error('connection lost'); });
    const app    = makeApp(db, config, counter);

    const res = await request(app)
      .post('/write/trade')
      .set('Content-Type', 'application/json')
      .send([{ _id: 1 }]);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'connection lost' });
    expect(counter).not.toHaveBeenCalled();
  });
});

// ── POST /write/:table — oversize body ────────────────────────────────────────

describe('POST /write/:table — body too large', () => {
  it('returns 413 when the body exceeds the limit', async () => {
    const { db, collection } = makeDb(async () => ({ insertedCount: 0 }));
    const app                = makeApp(db, config, counter);

    /** Build a payload bigger than 32 MB by repeating a fat string. */
    const fat  = 'x'.repeat(2_000_000);
    const docs = Array.from({ length: 20 }, (_, i) => ({ _id: i, fat }));

    const res = await request(app)
      .post('/write/trade')
      .set('Content-Type', 'application/json')
      .send(docs);

    expect(res.status).toBe(413);
    expect(collection.insertMany).not.toHaveBeenCalled();
    expect(counter).not.toHaveBeenCalled();
  });
});
