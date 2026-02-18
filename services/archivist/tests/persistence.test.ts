import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startConsuming } from '../src/persistence';
import { MongoError, Long } from 'mongodb';

vi.mock('amqplib');

describe('Message persistence', () => {
  let mockChannel: any;
  let mockDb: any;
  let mockCollection: any;

  beforeEach(() => {
    mockCollection = {
      insertOne: vi.fn().mockResolvedValue({ insertedCount: 1 })
    };

    mockDb = {
      collection: vi.fn().mockReturnValue(mockCollection)
    };

    mockChannel = {
      assertQueue: vi.fn().mockResolvedValue({}),
      prefetch: vi.fn().mockResolvedValue({}),
      consume: vi.fn((_queue, callback) => {
        (mockChannel as any)._callback = callback;
      }),
      ack: vi.fn(),
      nack: vi.fn()
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('startConsuming', () => {
    it('should setup queue', async () => {
      const onStoreMsg = vi.fn();
      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      expect(mockChannel.assertQueue).toHaveBeenCalledWith('archivist', { durable: true });
    });

    it('should set prefetch to batch size', async () => {
      const onStoreMsg = vi.fn();
      await startConsuming(mockChannel, mockDb, 50, onStoreMsg);

      expect(mockChannel.prefetch).toHaveBeenCalledWith(50);
    });

    it('should start consuming from queue', async () => {
      const onStoreMsg = vi.fn();
      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      expect(mockChannel.consume).toHaveBeenCalledWith('archivist', expect.any(Function));
    });

    it('should handle null message gracefully', async () => {
      const onStoreMsg = vi.fn();
      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(null);

      expect(mockChannel.ack).not.toHaveBeenCalled();
      expect(mockChannel.nack).not.toHaveBeenCalled();
    });

    it('should use table header as collection name', async () => {
      const onStoreMsg = vi.fn();
      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const message = {
        content: Buffer.from(JSON.stringify({ value: 42 })),
        properties: {
          headers: {
            table: 'orderBookL2'
          }
        }
      };

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      expect(mockDb.collection).toHaveBeenCalledWith('orderBookL2');
    });

    it('should merge metadata and JSON content into document', async () => {
      const onStoreMsg = vi.fn();
      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const message = {
        content: Buffer.from(JSON.stringify({ price: 50000, quantity: 1 })),
        properties: {
          contentType: 'application/json',
          headers: {
            table: 'trade',
            metadata: {
              _id: 'doc-123',
              symbol: 'XBTUSD'
            }
          }
        }
      };

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      const insertedDoc = mockCollection.insertOne.mock.calls[0][0];
      expect(insertedDoc).toEqual({
        _id: 'doc-123',
        symbol: 'XBTUSD',
        price: 50000,
        quantity: 1
      });
      expect(mockChannel.ack).toHaveBeenCalledWith(message);
    });

    it('should parse JSON by default when contentType not specified', async () => {
      const onStoreMsg = vi.fn();
      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const message = {
        content: Buffer.from(JSON.stringify({ value: 100 })),
        properties: {
          headers: {
            table: 'quote'
          }
        }
      };

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      const insertedDoc = mockCollection.insertOne.mock.calls[0][0];
      expect(insertedDoc).toEqual({ value: 100 });
    });

    it('should wrap binary content when contentType is application/octet-stream', async () => {
      const onStoreMsg = vi.fn();
      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      const message = {
        content: binaryData,
        properties: {
          contentType: 'application/octet-stream',
          headers: {
            table: 'compressed'
          }
        }
      };

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      const insertedDoc = mockCollection.insertOne.mock.calls[0][0];
      expect(insertedDoc).toEqual({ message: binaryData });
    });

    it('should ack message on successful insert', async () => {
      const onStoreMsg = vi.fn();
      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const message = {
        content: Buffer.from(JSON.stringify({ data: 'test' })),
        properties: {
          headers: { table: 'test' }
        }
      };

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      expect(mockChannel.ack).toHaveBeenCalledWith(message);
      expect(mockChannel.nack).not.toHaveBeenCalled();
      expect(onStoreMsg).toHaveBeenCalled();
    });

    it('should ack duplicate key errors (11000) as idempotent', async () => {
      const onStoreMsg = vi.fn();
      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const message = {
        content: Buffer.from(JSON.stringify({ _id: 'doc-1' })),
        properties: {
          headers: {
            table: 'events',
            metadata: { _id: 'doc-1' }
          }
        }
      };

      const error = Object.create(MongoError.prototype);
      error.code = 11000;
      mockCollection.insertOne.mockRejectedValueOnce(error);

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      expect(mockChannel.ack).toHaveBeenCalledWith(message);
      expect(mockChannel.nack).not.toHaveBeenCalled();
    });

    it('should nack other errors with requeue', async () => {
      const onStoreMsg = vi.fn();
      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const message = {
        content: Buffer.from(JSON.stringify({ data: 'test' })),
        properties: {
          headers: { table: 'events' }
        }
      };

      mockCollection.insertOne.mockRejectedValueOnce(new Error('Connection timeout'));

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      expect(mockChannel.nack).toHaveBeenCalledWith(message, false, true);
      expect(mockChannel.ack).not.toHaveBeenCalled();
    });

    it('should call onStoreMsg on successful insert', async () => {
      const onStoreMsg = vi.fn();
      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const message = {
        content: Buffer.from(JSON.stringify({ data: 'test' })),
        properties: {
          headers: { table: 'test' }
        }
      };

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      expect(onStoreMsg).toHaveBeenCalled();
    });

    it('should not call onStoreMsg on error', async () => {
      const onStoreMsg = vi.fn();
      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const message = {
        content: Buffer.from(JSON.stringify({ data: 'test' })),
        properties: {
          headers: { table: 'test' }
        }
      };

      mockCollection.insertOne.mockRejectedValueOnce(new Error('Insert failed'));

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      expect(onStoreMsg).not.toHaveBeenCalled();
    });

    it('should throw when table header is missing', async () => {
      const onStoreMsg = vi.fn();
      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const message = {
        content: Buffer.from(JSON.stringify({ data: 'test' })),
        properties: {
          headers: {} // missing table
        }
      };

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      expect(mockChannel.nack).toHaveBeenCalled();
    });

    it('should convert Buffer metadata values to BSON Long (int64 BE)', async () => {
      const onStoreMsg = vi.fn();
      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      // Use a value > Number.MAX_SAFE_INTEGER to confirm no precision loss
      const bigValue = 9007199254740993n; // 2^53 + 1
      const idBuffer = Buffer.allocUnsafe(8);
      idBuffer.writeBigUInt64BE(bigValue);

      const message = {
        content: Buffer.from(JSON.stringify({ price: 50000 })),
        properties: {
          contentType: 'application/json',
          headers: {
            table: 'trade',
            metadata: { _id: idBuffer, symbol: 'XBTUSD' }
          }
        }
      };

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      const insertedDoc = mockCollection.insertOne.mock.calls[0][0];
      expect(insertedDoc._id).toBeInstanceOf(Long);
      expect((insertedDoc._id as Long).toBigInt()).toBe(bigValue);
      expect(insertedDoc.symbol).toBe('XBTUSD'); // non-Buffer passes through
    });

    it('should leave non-Buffer metadata values unchanged alongside Buffer values', async () => {
      const onStoreMsg = vi.fn();
      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const idBuffer = Buffer.allocUnsafe(8);
      idBuffer.writeBigUInt64BE(1n);

      const message = {
        content: Buffer.from(JSON.stringify({})),
        properties: {
          contentType: 'application/json',
          headers: {
            table: 'trade',
            metadata: { _id: idBuffer, symbol: 'XBTUSD', count: 42 }
          }
        }
      };

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      const insertedDoc = mockCollection.insertOne.mock.calls[0][0];
      expect(insertedDoc._id).toBeInstanceOf(Long);
      expect(insertedDoc.symbol).toBe('XBTUSD');
      expect(insertedDoc.count).toBe(42);
    });

    it('should handle empty metadata by not including it', async () => {
      const onStoreMsg = vi.fn();
      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const message = {
        content: Buffer.from(JSON.stringify({ value: 42 })),
        properties: {
          headers: {
            table: 'test'
            // no metadata
          }
        }
      };

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      const insertedDoc = mockCollection.insertOne.mock.calls[0][0];
      expect(insertedDoc).toEqual({ value: 42 });
    });
  });
});

