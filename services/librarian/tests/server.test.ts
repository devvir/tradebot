import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Application, type ErrorRequestHandler } from 'express';
import request from 'supertest';
import type { Db } from 'mongodb';
import { buildRouter } from '../src/server';
import type { Config, InsertCounter, ReadCounter } from '../src/types';

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

const makeApp = (db: Db, config: Config, writeCounter: InsertCounter, readCounter: ReadCounter): Application =>
  express()
    .use(express.json({ limit: '32mb' }))
    .use(buildRouter(db, config, writeCounter, readCounter))
    .use(errorHandler);

// ── Mongo mock ────────────────────────────────────────────────────────────────

interface MockCollection {
  insertMany: ReturnType<typeof vi.fn>;
  find:       ReturnType<typeof vi.fn>;
}

interface MockCursor {
  sort:    ReturnType<typeof vi.fn>;
  limit:   ReturnType<typeof vi.fn>;
  toArray: ReturnType<typeof vi.fn>;
}

interface MockSetup {
  db:             Db;
  collection:     MockCollection;
  collectionSpy:  ReturnType<typeof vi.fn>;
  cursor:         MockCursor;
}

const makeDb = (opts: {
  insertImpl?: (docs: unknown[]) => Promise<unknown>;
  findImpl?:   () => unknown[] | Promise<unknown[]>;
} = {}): MockSetup => {
  const insertImpl = opts.insertImpl ?? (async () => ({ insertedCount: 0 }));
  const findImpl   = opts.findImpl   ?? (() => []);

  const cursor: MockCursor = {
    sort:    vi.fn(() => cursor),
    limit:   vi.fn(() => cursor),
    toArray: vi.fn(async () => findImpl()),
  };

  const collection: MockCollection = {
    insertMany: vi.fn(insertImpl),
    find:       vi.fn(() => cursor),
  };

  const collectionSpy = vi.fn(() => collection);
  const db            = { collection: collectionSpy } as unknown as Db;

  return { db, collection, collectionSpy, cursor };
};

const config: Config = {
  database:         'speed_test',
  ignoreDuplicates: true,
};

let writeCounter: ReturnType<typeof vi.fn>;
let readCounter:  ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeCounter = vi.fn();
  readCounter  = vi.fn();
});

// ── Health ────────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with { ok: true }', async () => {
    const { db } = makeDb();
    const app    = makeApp(db, config, writeCounter, readCounter);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

// ── POST /:table — happy path ─────────────────────────────────────────────────

describe('POST /:table — happy path', () => {
  it('routes to the right collection and returns inserted count', async () => {
    const { db, collection, collectionSpy } = makeDb({ insertImpl: async () => ({ insertedCount: 3 }) });
    const app = makeApp(db, config, writeCounter, readCounter);

    const docs = [{ _id: 1, a: 1 }, { _id: 2, a: 2 }, { _id: 3, a: 3 }];

    const res = await request(app)
      .post('/trade')
      .set('Content-Type', 'application/json')
      .send(docs);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ inserted: 3 });
    expect(collectionSpy).toHaveBeenCalledWith('trade');
    expect(collection.insertMany).toHaveBeenCalledWith(docs, { ordered: false });
    expect(writeCounter).toHaveBeenCalledWith(3);
  });

  it('uses ordered: false so partial batches still insert', async () => {
    const { db, collection } = makeDb({ insertImpl: async () => ({ insertedCount: 1 }) });
    const app                = makeApp(db, config, writeCounter, readCounter);

    await request(app)
      .post('/quote')
      .set('Content-Type', 'application/json')
      .send([{ _id: 1, x: 'y' }]);

    expect(collection.insertMany.mock.calls[0]![1]).toEqual({ ordered: false });
  });
});

// ── POST /:table — bad input ──────────────────────────────────────────────────

describe('POST /:table — input validation', () => {
  it('returns 400 when body is not an array', async () => {
    const { db, collection } = makeDb();
    const app                = makeApp(db, config, writeCounter, readCounter);

    const res = await request(app)
      .post('/trade')
      .set('Content-Type', 'application/json')
      .send({ not: 'an array' });

    expect(res.status).toBe(400);
    expect(collection.insertMany).not.toHaveBeenCalled();
    expect(writeCounter).not.toHaveBeenCalled();
  });

  it('returns 400 when body is an empty array', async () => {
    const { db, collection } = makeDb();
    const app                = makeApp(db, config, writeCounter, readCounter);

    const res = await request(app)
      .post('/trade')
      .set('Content-Type', 'application/json')
      .send([]);

    expect(res.status).toBe(400);
    expect(collection.insertMany).not.toHaveBeenCalled();
  });
});

// ── POST /:table — duplicate key behavior ─────────────────────────────────────

describe('POST /:table — duplicate key (E11000)', () => {
  const dupError = (insertedCount: number) => Object.assign(new Error('E11000'), { code: 11000, result: { insertedCount } });

  it('returns 200 with duplicates: true when ignoreDuplicates is on', async () => {
    const { db } = makeDb({ insertImpl: async () => { throw dupError(2); } });
    const app    = makeApp(db, { ...config, ignoreDuplicates: true }, writeCounter, readCounter);

    const res = await request(app)
      .post('/trade')
      .set('Content-Type', 'application/json')
      .send([{ _id: 1 }, { _id: 2 }, { _id: 3 }]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ inserted: 2, duplicates: true });
    expect(writeCounter).toHaveBeenCalledWith(2);
  });

  it('returns 409 when ignoreDuplicates is off, reporting partial inserts', async () => {
    const { db } = makeDb({ insertImpl: async () => { throw dupError(2); } });
    const app    = makeApp(db, { ...config, ignoreDuplicates: false }, writeCounter, readCounter);

    const res = await request(app)
      .post('/trade')
      .set('Content-Type', 'application/json')
      .send([{ _id: 1 }, { _id: 2 }, { _id: 3 }]);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ inserted: 2, error: 'duplicate key' });
    expect(writeCounter).toHaveBeenCalledWith(2);
  });
});

// ── POST /:table — mongo errors ───────────────────────────────────────────────

describe('POST /:table — mongo error', () => {
  it('returns 500 with the error message when insertMany rejects', async () => {
    const { db } = makeDb({ insertImpl: async () => { throw new Error('connection lost'); } });
    const app    = makeApp(db, config, writeCounter, readCounter);

    const res = await request(app)
      .post('/trade')
      .set('Content-Type', 'application/json')
      .send([{ _id: 1 }]);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'connection lost' });
    expect(writeCounter).not.toHaveBeenCalled();
  });
});

// ── POST /:table — oversize body ──────────────────────────────────────────────

describe('POST /:table — body too large', () => {
  it('returns 413 when the body exceeds the limit', async () => {
    const { db, collection } = makeDb();
    const app                = makeApp(db, config, writeCounter, readCounter);

    /** Build a payload bigger than 32 MB by repeating a fat string. */
    const fat  = 'x'.repeat(2_000_000);
    const docs = Array.from({ length: 20 }, (_, i) => ({ _id: i, fat }));

    const res = await request(app)
      .post('/trade')
      .set('Content-Type', 'application/json')
      .send(docs);

    expect(res.status).toBe(413);
    expect(collection.insertMany).not.toHaveBeenCalled();
    expect(writeCounter).not.toHaveBeenCalled();
  });
});

// ── GET /:table — happy path ──────────────────────────────────────────────────

describe('GET /:table — happy path', () => {
  it('returns docs sorted by _id with default limit when no params', async () => {
    const found = [{ _id: 1 }, { _id: 2 }, { _id: 3 }];
    const { db, collection, collectionSpy, cursor } = makeDb({ findImpl: () => found });
    const app = makeApp(db, config, writeCounter, readCounter);

    const res = await request(app).get('/trade');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ docs: found });
    expect(collectionSpy).toHaveBeenCalledWith('trade');
    expect(collection.find).toHaveBeenCalledWith({});
    expect(cursor.sort).toHaveBeenCalledWith({ _id: 1 });
    expect(cursor.limit).toHaveBeenCalledWith(10_000);
    expect(readCounter).toHaveBeenCalledWith(3);
  });

  it('applies `from` as _id $gte', async () => {
    const { db, collection } = makeDb({ findImpl: () => [{ _id: 500 }] });
    const app                = makeApp(db, config, writeCounter, readCounter);

    const res = await request(app).get('/trade').query({ from: '500' });

    expect(res.status).toBe(200);
    expect(collection.find).toHaveBeenCalledWith({ _id: { $gte: 500 } });
  });

  it('honors a custom limit', async () => {
    const { db, cursor } = makeDb({ findImpl: () => [] });
    const app            = makeApp(db, config, writeCounter, readCounter);

    await request(app).get('/trade').query({ limit: '250' });

    expect(cursor.limit).toHaveBeenCalledWith(250);
  });

  it('merges `filter` JSON into the mongo query verbatim', async () => {
    const { db, collection } = makeDb({ findImpl: () => [] });
    const app                = makeApp(db, config, writeCounter, readCounter);

    const filter = { symbol: 'XBTUSD', side: 'Buy' };

    await request(app).get('/trade').query({ filter: JSON.stringify(filter) });

    expect(collection.find).toHaveBeenCalledWith(filter);
  });

  it('combines `from` and `filter` into one query', async () => {
    const { db, collection } = makeDb({ findImpl: () => [] });
    const app                = makeApp(db, config, writeCounter, readCounter);

    await request(app).get('/trade').query({ from: '100', filter: JSON.stringify({ symbol: 'XBTUSD' }) });

    expect(collection.find).toHaveBeenCalledWith({ symbol: 'XBTUSD', _id: { $gte: 100 } });
  });

  it('returns an empty array when nothing matches', async () => {
    const { db } = makeDb({ findImpl: () => [] });
    const app    = makeApp(db, config, writeCounter, readCounter);

    const res = await request(app).get('/trade');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ docs: [] });
    expect(readCounter).toHaveBeenCalledWith(0);
  });
});

// ── GET /:table — descending / before reads (additive) ────────────────────────

describe('GET /:table — order & before', () => {
  it('applies `before` as _id $lte', async () => {
    const { db, collection } = makeDb({ findImpl: () => [{ _id: 100 }] });
    const app                = makeApp(db, config, writeCounter, readCounter);

    await request(app).get('/trade').query({ before: '100' });

    expect(collection.find).toHaveBeenCalledWith({ _id: { $lte: 100 } });
  });

  it('sorts descending when order=desc', async () => {
    const { db, cursor } = makeDb({ findImpl: () => [] });
    const app            = makeApp(db, config, writeCounter, readCounter);

    await request(app).get('/trade').query({ order: 'desc' });

    expect(cursor.sort).toHaveBeenCalledWith({ _id: -1 });
  });

  it('combines from and before into one _id range', async () => {
    const { db, collection } = makeDb({ findImpl: () => [] });
    const app                = makeApp(db, config, writeCounter, readCounter);

    await request(app).get('/trade').query({ from: '10', before: '90' });

    expect(collection.find).toHaveBeenCalledWith({ _id: { $gte: 10, $lte: 90 } });
  });

  it('supports the binary-search probe: latest doc at-or-before X', async () => {
    const { db, collection, cursor } = makeDb({ findImpl: () => [{ _id: 73 }] });
    const app                        = makeApp(db, config, writeCounter, readCounter);

    await request(app).get('/orderBookL2').query({ before: '73', order: 'desc', limit: '1' });

    expect(collection.find).toHaveBeenCalledWith({ _id: { $lte: 73 } });
    expect(cursor.sort).toHaveBeenCalledWith({ _id: -1 });
    expect(cursor.limit).toHaveBeenCalledWith(1);
  });

  it('returns 400 when before is not a number', async () => {
    const { db, collection } = makeDb();
    const app                = makeApp(db, config, writeCounter, readCounter);

    const res = await request(app).get('/trade').query({ before: 'xyz' });

    expect(res.status).toBe(400);
    expect(collection.find).not.toHaveBeenCalled();
  });

  it('returns 400 when order is neither asc nor desc', async () => {
    const { db, collection } = makeDb();
    const app                = makeApp(db, config, writeCounter, readCounter);

    const res = await request(app).get('/trade').query({ order: 'sideways' });

    expect(res.status).toBe(400);
    expect(collection.find).not.toHaveBeenCalled();
  });
});

// ── GET /:table — input validation ────────────────────────────────────────────

describe('GET /:table — input validation', () => {
  it('returns 400 when limit is not a positive integer', async () => {
    const { db, collection } = makeDb();
    const app                = makeApp(db, config, writeCounter, readCounter);

    const res = await request(app).get('/trade').query({ limit: '0' });

    expect(res.status).toBe(400);
    expect(collection.find).not.toHaveBeenCalled();
  });

  it('returns 400 when from is not a number', async () => {
    const { db, collection } = makeDb();
    const app                = makeApp(db, config, writeCounter, readCounter);

    const res = await request(app).get('/trade').query({ from: 'abc' });

    expect(res.status).toBe(400);
    expect(collection.find).not.toHaveBeenCalled();
  });

  it('returns 400 when filter is not valid JSON', async () => {
    const { db, collection } = makeDb();
    const app                = makeApp(db, config, writeCounter, readCounter);

    const res = await request(app).get('/trade').query({ filter: '{not json' });

    expect(res.status).toBe(400);
    expect(collection.find).not.toHaveBeenCalled();
  });

  it('returns 400 when filter is JSON but not an object', async () => {
    const { db, collection } = makeDb();
    const app                = makeApp(db, config, writeCounter, readCounter);

    const res = await request(app).get('/trade').query({ filter: '[1,2,3]' });

    expect(res.status).toBe(400);
    expect(collection.find).not.toHaveBeenCalled();
  });
});

// ── GET /:table — mongo errors ────────────────────────────────────────────────

describe('GET /:table — mongo error', () => {
  it('returns 500 with the error message when the cursor rejects', async () => {
    const { db } = makeDb({ findImpl: () => { throw new Error('connection lost'); } });
    const app    = makeApp(db, config, writeCounter, readCounter);

    const res = await request(app).get('/trade');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'connection lost' });
    expect(readCounter).not.toHaveBeenCalled();
  });
});
