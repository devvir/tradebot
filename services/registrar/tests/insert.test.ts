import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MongoClient } from 'mongodb';
import { flushBatch } from '../src/insert';
import type { PendingEntry } from '../src/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeEntry = (id: number, doc = {}): PendingEntry & { ack: ReturnType<typeof vi.fn>; nack: ReturnType<typeof vi.fn> } => ({
  _id:  id,
  doc,
  ack:  vi.fn(),
  nack: vi.fn(),
});

const makeMongoClient = (insertManyImpl: () => Promise<unknown>): MongoClient => {
  const collection = { insertMany: vi.fn(insertManyImpl) };
  const db         = { collection: vi.fn(() => collection) };

  return { db: vi.fn(() => db) } as unknown as MongoClient;
};

// ── no-op on empty batch ──────────────────────────────────────────────────────

describe('flushBatch — empty entries', () => {
  it('returns immediately without touching mongo', async () => {
    const dbSpy = vi.fn();
    const mongo = { db: dbSpy } as unknown as MongoClient;

    await flushBatch(mongo, 'tradebot', 'trade', []);

    expect(dbSpy).not.toHaveBeenCalled();
  });
});

// ── successful insert ─────────────────────────────────────────────────────────

describe('flushBatch — success', () => {
  it('acks all entries on successful insertMany', async () => {
    const entries = [makeEntry(1, { symbol: 'XBTUSD' }), makeEntry(2, { symbol: 'ETHUSD' })];
    const mongo   = makeMongoClient(() => Promise.resolve({ insertedCount: 2 }));

    await flushBatch(mongo, 'tradebot', 'trade', entries);

    expect(entries[0]!.ack).toHaveBeenCalledOnce();
    expect(entries[1]!.ack).toHaveBeenCalledOnce();
    expect(entries[0]!.nack).not.toHaveBeenCalled();
  });

  it('passes _id merged into the document', async () => {
    let inserted: unknown;
    const mongo = makeMongoClient(() => {
      inserted = args;
      return Promise.resolve({});
    });

    // Capture args via spy
    const collection = mongo.db('').collection('');
    const spy = vi.spyOn(collection, 'insertMany').mockResolvedValue({ insertedCount: 1 } as never);

    const entries = [makeEntry(99, { symbol: 'XBTUSD' })];
    await flushBatch(mongo, 'tradebot', 'trade', entries);

    const docs = spy.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(docs[0]).toMatchObject({ _id: 99, symbol: 'XBTUSD' });
  });
});

// ── duplicate key (E11000) ────────────────────────────────────────────────────

describe('flushBatch — duplicate key', () => {
  it('acks entries silently on E11000', async () => {
    const entries = [makeEntry(1)];
    const mongo   = makeMongoClient(() => {
      const err: NodeJS.ErrnoException = new Error('E11000 duplicate key error');
      (err as any).code = 11000;
      return Promise.reject(err);
    });

    await flushBatch(mongo, 'tradebot', 'trade', entries);

    expect(entries[0]!.ack).toHaveBeenCalledOnce();
    expect(entries[0]!.nack).not.toHaveBeenCalled();
  });
});

// ── transient error → retry → success ────────────────────────────────────────

describe('flushBatch — transient error then success', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('retries and acks on eventual success', async () => {
    let calls = 0;
    const mongo = makeMongoClient(() => {
      calls++;
      if (calls < 3) return Promise.reject(new Error('temporary failure'));
      return Promise.resolve({});
    });

    const entries = [makeEntry(1)];
    const promise = flushBatch(mongo, 'tradebot', 'trade', entries);

    // Advance through retry delays
    await vi.runAllTimersAsync();
    await promise;

    expect(calls).toBe(3);
    expect(entries[0]!.ack).toHaveBeenCalledOnce();
    expect(entries[0]!.nack).not.toHaveBeenCalled();
  });
});

// ── max retries exhausted → nack ─────────────────────────────────────────────

describe('flushBatch — max retries exhausted', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('nacks all entries after 3 failed attempts', async () => {
    const mongo   = makeMongoClient(() => Promise.reject(new Error('persistent failure')));
    const entries = [makeEntry(1), makeEntry(2)];
    const promise = flushBatch(mongo, 'tradebot', 'trade', entries);

    await vi.runAllTimersAsync();
    await promise;

    expect(entries[0]!.nack).toHaveBeenCalledWith(true);
    expect(entries[1]!.nack).toHaveBeenCalledWith(true);
    expect(entries[0]!.ack).not.toHaveBeenCalled();
  });
});
