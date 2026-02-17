import { vi, describe, it, expect, beforeEach, afterEach, type MockedFunction } from 'vitest';
import { startConsuming } from '../src/persistence';
import * as mongodb from '../src/mongodb';
import { MongoError } from 'mongodb';

vi.mock('../src/mongodb');
vi.mock('amqplib');

const mockGetCollectionName = mongodb.getCollectionName as MockedFunction<
  typeof mongodb.getCollectionName
>;

describe('Message persistence', () => {
  let mockChannel: any;
  let mockDb: any;
  let mockCollection: any;

  beforeEach(() => {
    mockCollection = {
      insertOne: vi.fn().mockResolvedValue({ insertedCount: 1 }),
      createIndex: vi.fn().mockResolvedValue('_hash_1')
    };

    mockDb = {
      collection: vi.fn().mockReturnValue(mockCollection),
      listCollections: vi.fn().mockReturnValue({
        hasNext: vi.fn().mockResolvedValue(true)
      }),
      createCollection: vi.fn().mockResolvedValue(mockCollection)
    };

    mockChannel = {
      assertQueue: vi.fn().mockResolvedValue({}),
      prefetch: vi.fn().mockResolvedValue({}),
      consume: vi.fn((_queue, callback) => {
        // Store the callback so tests can call it
        (mockChannel as any)._callback = callback;
      }),
      ack: vi.fn(),
      nack: vi.fn()
    };

    mockGetCollectionName.mockReturnValue('trade_XBTUSD');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('startConsuming', () => {
    it('should setup queue', async () => {
      const onStoreMsg = vi.fn();

      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      expect(mockChannel.assertQueue).toHaveBeenCalledWith(
        'archivist',
        { durable: true }
      );
    });

    it('should set prefetch to batch size', async () => {
      const onStoreMsg = vi.fn();

      await startConsuming(mockChannel, mockDb, 50, onStoreMsg);

      expect(mockChannel.prefetch).toHaveBeenCalledWith(50);
    });

    it('should start consuming from queue', async () => {
      const onStoreMsg = vi.fn();

      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      expect(mockChannel.consume).toHaveBeenCalledWith(
        'archivist',
        expect.any(Function)
      );
    });

    it('should handle null message gracefully', async () => {
      const onStoreMsg = vi.fn();

      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(null);

      expect(mockChannel.ack).not.toHaveBeenCalled();
      expect(mockChannel.nack).not.toHaveBeenCalled();
    });

    it('should process valid message', async () => {
      const onStoreMsg = vi.fn();

      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const message = {
        content: Buffer.from(JSON.stringify({
          table: 'trade',
          action: 'insert',
          data: [{ symbol: 'XBTUSD', price: 50000, timestamp: '2024-01-01T00:00:00.000Z' }]
        }))
      };

      mockGetCollectionName.mockReturnValue('trade_XBTUSD');
      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      expect(mockGetCollectionName).toHaveBeenCalled();
      expect(mockDb.collection).toHaveBeenCalledWith('trade_XBTUSD');
      expect(mockCollection.insertOne).toHaveBeenCalled();
      expect(onStoreMsg).toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(message);
    });

    it('should handle duplicate key error', async () => {
      const onStoreMsg = vi.fn();

      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const message = {
        content: Buffer.from(JSON.stringify({
          table: 'trade',
          action: 'insert',
          data: [{ symbol: 'XBTUSD', price: 50000, timestamp: '2024-01-01T00:00:00.000Z' }]
        }))
      };

      // Create a MongoError-like object with code 11000
      const error = Object.create(MongoError.prototype);
      error.code = 11000;
      error.message = 'E11000 duplicate key error';
      mockCollection.insertOne.mockRejectedValueOnce(error);

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      // Duplicate errors should be ack'd (not requeued)
      expect(mockChannel.ack).toHaveBeenCalledWith(message);
      expect(mockChannel.nack).not.toHaveBeenCalled();
    });

    it('should requeue message on transient error', async () => {
      const onStoreMsg = vi.fn();

      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const message = {
        content: Buffer.from(JSON.stringify({
          table: 'trade',
          action: 'insert',
          data: [{ symbol: 'XBTUSD', price: 50000, timestamp: '2024-01-01T00:00:00.000Z' }]
        }))
      };

      const error = new Error('Connection timeout');
      mockCollection.insertOne.mockRejectedValueOnce(error);

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      // Transient errors should be nack'd with requeue=true
      expect(mockChannel.nack).toHaveBeenCalledWith(message, false, true);
      expect(mockChannel.ack).not.toHaveBeenCalled();
    });

    it('should filter out unlisted instruments', async () => {
      const onStoreMsg = vi.fn();

      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const message = {
        content: Buffer.from(JSON.stringify({
          table: 'instrument',
          action: 'partial',
          data: [
            { symbol: 'XBTUSD', state: 'Open' },
            { symbol: 'ETHUSD', state: 'Unlisted' }
          ]
        }))
      };

      mockGetCollectionName.mockReturnValue('instrument');
      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      // Should have filtered out unlisted and only inserted valid data
      expect(mockCollection.insertOne).toHaveBeenCalled();
      const insertCall = mockCollection.insertOne.mock.calls[0][0];
      expect(insertCall.data).toHaveLength(1);
      expect(insertCall.data[0].symbol).toBe('XBTUSD');
      expect(mockChannel.ack).toHaveBeenCalledWith(message);
    });

    it('should ack message if all instruments are unlisted', async () => {
      const onStoreMsg = vi.fn();

      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const message = {
        content: Buffer.from(JSON.stringify({
          table: 'instrument',
          action: 'partial',
          data: [
            { symbol: 'ETHUSD', state: 'Unlisted' }
          ]
        }))
      };

      mockGetCollectionName.mockReturnValue('instrument');
      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      // Should ack without inserting since all data was filtered
      expect(mockCollection.insertOne).not.toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(message);
    });
  });
});
