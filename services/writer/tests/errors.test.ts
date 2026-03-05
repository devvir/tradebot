import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleBatchError } from '../src/errors';
import { MongoBulkWriteError, MongoError } from 'mongodb';
import type { BatchEntry, ErrorContext } from '../src/types';

vi.mock('@devvir/service', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../src/documentId', () => ({
  moveToNextSlot: vi.fn(),
}));

import * as documentId from '../src/documentId';

/** Build a minimal BatchEntry with a routing key, redelivered flag, and optional headers. */
const entry = (
  routingKey: string,
  doc: Record<string, unknown>,
  redelivered = false,
  headers?: Record<string, unknown>,
): BatchEntry => ({
  delivery: {
    metadata: { routingKey, redelivered, exchange: 'writer', deliveryTag: 1, raw: {} as any, properties: {} as any, headers },
    ack: vi.fn(),
    nack: vi.fn(),
    original: {
      content: Buffer.from(JSON.stringify(doc)),
      fields: { routingKey, redelivered } as any,
      properties: { headers: headers ?? {} } as any,
    } as any,
  },
  document: doc,
});

/** Build a MongoBulkWriteError with specific writeErrors. */
const bulkError = (writeErrors: Array<{ index: number; code: number; errmsg?: string }>): MongoBulkWriteError => {
  const err = Object.create(MongoBulkWriteError.prototype) as MongoBulkWriteError;

  Object.defineProperty(err, 'writeErrors', {
    value: writeErrors.map(we => ({
      index: we.index,
      code: we.code,
      errmsg: we.errmsg ?? `Error code ${we.code}`,
    })),
  });

  return err;
};

const ctx: ErrorContext = { collection: 'trade', queue: 'writer.collect' };

describe('handleBatchError', () => {
  let mockCollection: any;
  let onStoreMsg: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockCollection = {
      insertOne: vi.fn().mockResolvedValue({ insertedId: 'ok' }),
    };

    onStoreMsg = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── MongoBulkWriteError (partial failure) ────────────────────────────────

  describe('partial failure (MongoBulkWriteError)', () => {
    it('should ACK entries that are not in writeErrors', async () => {
      const entries = [
        entry('collect.trade', { v: 1 }),
        entry('collect.trade', { v: 2 }),
        entry('collect.trade', { v: 3 }),
      ];

      // Only index 1 failed
      const error = bulkError([{ index: 1, code: 999 }]);

      await handleBatchError(error, entries, mockCollection, onStoreMsg, ctx);

      // Indices 0 and 2 were inserted successfully → ACK
      expect(entries[0].delivery.ack).toHaveBeenCalled();
      expect(entries[2].delivery.ack).toHaveBeenCalled();
      expect(onStoreMsg).toHaveBeenCalledTimes(2);
    });

    it('should ACK duplicate key writeErrors (slot collision)', async () => {
      const entries = [
        entry('collect.trade', { _id: 'dup1' }),
        entry('collect.trade', { _id: 'dup2' }),
      ];

      const error = bulkError([
        { index: 0, code: 11000 },
        { index: 1, code: 11000 },
      ]);

      await handleBatchError(error, entries, mockCollection, onStoreMsg, ctx);

      expect(entries[0].delivery.ack).toHaveBeenCalled();
      expect(entries[1].delivery.ack).toHaveBeenCalled();
      expect(onStoreMsg).toHaveBeenCalledTimes(2);
    });

    it('should call moveToNextSlot when duplicate key errors are present', async () => {
      const entries = [entry('collect.trade', { _id: 'dup1' })];
      const error = bulkError([{ index: 0, code: 11000 }]);

      await handleBatchError(error, entries, mockCollection, onStoreMsg, ctx);

      expect(documentId.moveToNextSlot).toHaveBeenCalledOnce();
    });

    it('should not call moveToNextSlot when no duplicate key errors', async () => {
      const entries = [entry('collect.trade', { v: 1 })];
      const error = bulkError([{ index: 0, code: 999 }]);

      await handleBatchError(error, entries, mockCollection, onStoreMsg, ctx);

      expect(documentId.moveToNextSlot).not.toHaveBeenCalled();
    });

    it('should NACK with requeue on first-attempt failures', async () => {
      const entries = [
        entry('collect.trade', { v: 1 }, false), // redelivered = false
      ];

      const error = bulkError([{ index: 0, code: 999 }]);

      await handleBatchError(error, entries, mockCollection, onStoreMsg, ctx);

      expect(entries[0].delivery.nack).toHaveBeenCalledWith(true);
      expect(entries[0].delivery.ack).not.toHaveBeenCalled();
    });

    it('should dead-letter redelivered messages that still fail', async () => {
      const entries = [
        entry('collect.trade', { v: 1 }, true), // redelivered = true
      ];

      const error = bulkError([{ index: 0, code: 999 }]);

      await handleBatchError(error, entries, mockCollection, onStoreMsg, ctx);

      // nack without requeue → dead-lettered
      expect(entries[0].delivery.nack).toHaveBeenCalledWith(false);
      expect(entries[0].delivery.ack).not.toHaveBeenCalled();
    });

    it('should handle mixed success, duplicate, and failure in one batch', async () => {
      const entries = [
        entry('collect.trade', { v: 1 }, false),        // index 0: inserted OK
        entry('collect.trade', { _id: 'dup' }, false),   // index 1: duplicate
        entry('collect.trade', { v: 3 }, true),           // index 2: validation error, redelivered
        entry('collect.trade', { v: 4 }, false),          // index 3: validation error, first attempt
      ];

      const error = bulkError([
        { index: 1, code: 11000 },
        { index: 2, code: 121, errmsg: 'Document validation failed' },
        { index: 3, code: 121, errmsg: 'Document validation failed' },
      ]);

      await handleBatchError(error, entries, mockCollection, onStoreMsg, ctx);

      // index 0: not in writeErrors → ACK
      expect(entries[0].delivery.ack).toHaveBeenCalled();
      // index 1: duplicate → ACK (slot collision)
      expect(entries[1].delivery.ack).toHaveBeenCalled();
      // index 2: redelivered + fail → dead-letter (nack without requeue)
      expect(entries[2].delivery.nack).toHaveBeenCalledWith(false);
      // index 3: first attempt + fail → requeue
      expect(entries[3].delivery.nack).toHaveBeenCalledWith(true);

      expect(onStoreMsg).toHaveBeenCalledTimes(2); // index 0 and 1
    });
  });

  // ── Total failure (non-bulk error) ───────────────────────────────────────

  describe('total failure (insertOne fallback)', () => {
    it('should fall back to insertOne and ACK individually on success', async () => {
      const entries = [
        entry('collect.trade', { v: 1 }),
        entry('collect.trade', { v: 2 }),
      ];

      const error = new Error('Connection timeout');

      await handleBatchError(error, entries, mockCollection, onStoreMsg, ctx);

      expect(mockCollection.insertOne).toHaveBeenCalledTimes(2);
      expect(mockCollection.insertOne).toHaveBeenCalledWith({ v: 1 });
      expect(mockCollection.insertOne).toHaveBeenCalledWith({ v: 2 });
      expect(entries[0].delivery.ack).toHaveBeenCalled();
      expect(entries[1].delivery.ack).toHaveBeenCalled();
      expect(onStoreMsg).toHaveBeenCalledTimes(2);
    });

    it('should ACK duplicates during insertOne fallback (slot collision)', async () => {
      const entries = [entry('collect.trade', { _id: 'dup' })];

      const dupError = Object.assign(Object.create(MongoError.prototype), { code: 11000 });
      mockCollection.insertOne.mockRejectedValueOnce(dupError);

      const error = new Error('Connection timeout');

      await handleBatchError(error, entries, mockCollection, onStoreMsg, ctx);

      expect(entries[0].delivery.ack).toHaveBeenCalled();
      expect(entries[0].delivery.nack).not.toHaveBeenCalled();
      expect(onStoreMsg).toHaveBeenCalledTimes(1);
    });

    it('should call moveToNextSlot when duplicate key errors during insertOne fallback', async () => {
      const entries = [entry('collect.trade', { _id: 'dup' })];

      const dupError = Object.assign(Object.create(MongoError.prototype), { code: 11000 });
      mockCollection.insertOne.mockRejectedValueOnce(dupError);

      const error = new Error('Connection timeout');

      await handleBatchError(error, entries, mockCollection, onStoreMsg, ctx);

      expect(documentId.moveToNextSlot).toHaveBeenCalledOnce();
    });

    it('should requeue first-attempt failures during insertOne fallback', async () => {
      const entries = [entry('collect.trade', { v: 1 }, false)];

      const mongoErr = Object.assign(Object.create(MongoError.prototype), { code: 999 });
      mockCollection.insertOne.mockRejectedValueOnce(mongoErr);

      const error = new Error('Connection timeout');

      await handleBatchError(error, entries, mockCollection, onStoreMsg, ctx);

      expect(entries[0].delivery.nack).toHaveBeenCalledWith(true);
      expect(entries[0].delivery.ack).not.toHaveBeenCalled();
    });

    it('should dead-letter redelivered failures during insertOne fallback', async () => {
      const entries = [entry('collect.trade', { v: 1 }, true)];

      const mongoErr = Object.assign(Object.create(MongoError.prototype), { code: 999 });
      mockCollection.insertOne.mockRejectedValueOnce(mongoErr);

      const error = new Error('Connection timeout');

      await handleBatchError(error, entries, mockCollection, onStoreMsg, ctx);

      // nack without requeue → dead-lettered
      expect(entries[0].delivery.nack).toHaveBeenCalledWith(false);
      expect(entries[0].delivery.ack).not.toHaveBeenCalled();
    });

    it('should isolate the bad message when only one in the batch fails', async () => {
      const entries = [
        entry('collect.trade', { v: 1 }, false),
        entry('collect.trade', { v: 'poison' }, false), // will fail
        entry('collect.trade', { v: 3 }, false),
      ];

      const mongoErr = Object.assign(Object.create(MongoError.prototype), { code: 121 });
      mockCollection.insertOne
        .mockResolvedValueOnce({ insertedId: '1' })       // v: 1 OK
        .mockRejectedValueOnce(mongoErr)                   // v: 'poison' fails
        .mockResolvedValueOnce({ insertedId: '3' });       // v: 3 OK

      const error = new Error('Connection timeout');

      await handleBatchError(error, entries, mockCollection, onStoreMsg, ctx);

      // v: 1 and v: 3 succeed → ACK
      expect(entries[0].delivery.ack).toHaveBeenCalled();
      expect(entries[2].delivery.ack).toHaveBeenCalled();
      // v: 'poison' first attempt → requeue
      expect(entries[1].delivery.nack).toHaveBeenCalledWith(true);
      expect(onStoreMsg).toHaveBeenCalledTimes(2);
    });

    it('should dead-letter non-Mongo errors during insertOne fallback for redelivered messages', async () => {
      const entries = [entry('collect.trade', { v: 1 }, true)];

      mockCollection.insertOne.mockRejectedValueOnce(new Error('Unexpected'));

      const error = new Error('Connection timeout');

      await handleBatchError(error, entries, mockCollection, onStoreMsg, ctx);

      expect(entries[0].delivery.nack).toHaveBeenCalledWith(false);
    });
  });
});
