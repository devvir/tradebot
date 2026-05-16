import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MongoClient } from 'mongodb';
import { flushBatch } from '../src/insert';
import { _test_buckets as buckets, _test_reset as resetProgress } from '../src/progress';
import type { PendingEntry } from '../src/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeEntry = (
  id: number,
  doc:      Record<string, unknown> = {},
  table:    string                  = 'trade',
  date:     string                  = '20260101',
  msgIndex: number                  = id,
): PendingEntry & { ack: ReturnType<typeof vi.fn>; nack: ReturnType<typeof vi.fn> } => ({
  _id:  id,
  doc,
  table,
  date,
  msgIndex,
  ack:  vi.fn(),
  nack: vi.fn(),
});

const makeMongoClient = (insertManyImpl: () => Promise<unknown>): MongoClient => {
  const collection = { insertMany: vi.fn(insertManyImpl) };
  const db         = { collection: vi.fn(() => collection) };

  return { db: vi.fn(() => db) } as unknown as MongoClient;
};

beforeEach(() => {
  resetProgress();
});

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
    let captured: Array<Record<string, unknown>> | undefined;

    const collection = {
      insertMany: vi.fn().mockImplementation((docs: Array<Record<string, unknown>>) => {
        captured = docs;
        return Promise.resolve({ insertedCount: docs.length });
      }),
    };
    const mongo = { db: vi.fn(() => ({ collection: vi.fn(() => collection) })) } as unknown as MongoClient;

    const entries = [makeEntry(99, { symbol: 'XBTUSD' })];

    await flushBatch(mongo, 'tradebot', 'trade', entries);

    expect(captured?.[0]).toMatchObject({ _id: 99, symbol: 'XBTUSD' });
  });

  it('bumps the in-memory progress counter for each entry on success', async () => {
    const entries = [
      makeEntry(1, {}, 'trade', '20260101', 7),
      makeEntry(2, {}, 'trade', '20260101', 12),
    ];
    const mongo = makeMongoClient(() => Promise.resolve({}));

    await flushBatch(mongo, 'tradebot', 'trade', entries);

    expect(buckets.get('trade:20260101')?.counter).toBe(12);
  });

  it('tracks per-bucket counters independently when batches span buckets', async () => {
    const entries = [
      makeEntry(1, {}, 'trade', '20260101', 5),
      makeEntry(2, {}, 'trade', '20260102', 8),
    ];
    const mongo = makeMongoClient(() => Promise.resolve({}));

    await flushBatch(mongo, 'tradebot', 'trade', entries);

    expect(buckets.get('trade:20260101')?.counter).toBe(5);
    expect(buckets.get('trade:20260102')?.counter).toBe(8);
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

  it('bumps the progress counter on E11000 (already stored counts as stored)', async () => {
    const entries = [makeEntry(1, {}, 'trade', '20260101', 42)];
    const mongo   = makeMongoClient(() => {
      const err: NodeJS.ErrnoException = new Error('E11000 duplicate key error');
      (err as any).code = 11000;
      return Promise.reject(err);
    });

    await flushBatch(mongo, 'tradebot', 'trade', entries);

    expect(buckets.get('trade:20260101')?.counter).toBe(42);
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

  it('does not bump the progress counter when the batch is nacked', async () => {
    const mongo   = makeMongoClient(() => Promise.reject(new Error('persistent failure')));
    const entries = [makeEntry(1, {}, 'trade', '20260101', 99)];
    const promise = flushBatch(mongo, 'tradebot', 'trade', entries);

    await vi.runAllTimersAsync();
    await promise;

    expect(buckets.has('trade:20260101')).toBe(false);
  });
});
