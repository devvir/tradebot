import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registry } from '@devvir/service-kit';
import type { MongoClient } from 'mongodb';
import { recordError, _test_ERROR_DB as ERROR_DB } from '../../src/write/errors';
import { makeId } from '../../src/write/id';

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeMongo = (insertOneImpl: (doc: unknown) => Promise<unknown>): {
  mongo: MongoClient;
  insertOne: ReturnType<typeof vi.fn>;
  db: ReturnType<typeof vi.fn>;
  collection: ReturnType<typeof vi.fn>;
} => {
  const insertOne   = vi.fn(insertOneImpl);
  const collection  = vi.fn(() => ({ insertOne }));
  const db          = vi.fn(() => ({ collection }));
  const mongo       = { db } as unknown as MongoClient;

  return { mongo, insertOne, db, collection };
};

beforeEach(() => {
  vi.mocked(registry.get).mockReset();
});

// ── Happy path ───────────────────────────────────────────────────────────────

describe('recordError — happy path', () => {
  it('writes { _id, message } to farmer.<table>', async () => {
    const m = makeMongo(() => Promise.resolve({ insertedId: 1 }));

    vi.mocked(registry.get).mockReturnValue({
      providers: { get: vi.fn(() => m.mongo) },
    } as never);

    await recordError('trade', '20240315', 42, 'corrupt-line');

    expect(m.db).toHaveBeenCalledWith(ERROR_DB);
    expect(m.collection).toHaveBeenCalledWith('trade');
    expect(m.insertOne).toHaveBeenCalledWith({
      _id:     makeId('20240315', 42),
      message: 'corrupt-line',
    });
  });

  it('writes to the per-table collection name', async () => {
    const m = makeMongo(() => Promise.resolve({}));

    vi.mocked(registry.get).mockReturnValue({
      providers: { get: vi.fn(() => m.mongo) },
    } as never);

    await recordError('orderBookL2', '20240315', 1, 'x');

    expect(m.collection).toHaveBeenCalledWith('orderBookL2');
  });
});

// ── Swallows duplicate-key ────────────────────────────────────────────────────

describe('recordError — already-seen corruption (E11000)', () => {
  it('does not re-throw on duplicate key', async () => {
    const m = makeMongo(() => Promise.reject(Object.assign(new Error('dup'), { code: 11000 })));

    vi.mocked(registry.get).mockReturnValue({
      providers: { get: vi.fn(() => m.mongo) },
    } as never);

    await expect(
      recordError('trade', '20240315', 42, 'corrupt-line'),
    ).resolves.toBeUndefined();
  });
});

// ── Swallows other errors with log ────────────────────────────────────────────

describe('recordError — other mongo errors', () => {
  it('does not re-throw on unrelated errors (logs and continues)', async () => {
    const m = makeMongo(() => Promise.reject(new Error('connection refused')));

    vi.mocked(registry.get).mockReturnValue({
      providers: { get: vi.fn(() => m.mongo) },
    } as never);

    await expect(
      recordError('trade', '20240315', 42, 'corrupt-line'),
    ).resolves.toBeUndefined();
  });
});
