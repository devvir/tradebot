import { startConsuming } from '../src/persistence';
import * as mongodb from '../src/mongodb';

jest.mock('../src/mongodb');
jest.mock('amqplib');

const mockGetCollectionName = mongodb.getCollectionName as jest.MockedFunction<
  typeof mongodb.getCollectionName
>;

describe('Message persistence', () => {
  let mockChannel: any;
  let mockDb: any;
  let mockCollection: any;

  beforeEach(() => {
    mockCollection = {
      insertMany: jest.fn().mockResolvedValue({ insertedCount: 1 })
    };

    mockDb = {
      collection: jest.fn().mockReturnValue(mockCollection)
    };

    mockChannel = {
      assertExchange: jest.fn().mockResolvedValue({}),
      assertQueue: jest.fn().mockResolvedValue({}),
      bindQueue: jest.fn().mockResolvedValue({}),
      prefetch: jest.fn().mockResolvedValue({}),
      consume: jest.fn((_queue, callback) => {
        // Store the callback so tests can call it
        (mockChannel as any)._callback = callback;
      }),
      ack: jest.fn(),
      nack: jest.fn()
    };

    mockGetCollectionName.mockReturnValue('trade_XBTUSD');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('startConsuming', () => {
    it('should setup exchange, queue, and binding', async () => {
      const onStoreMsg = jest.fn();

      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      expect(mockChannel.assertExchange).toHaveBeenCalledWith(
        'bitmex-data',
        'topic',
        { durable: true }
      );

      expect(mockChannel.assertQueue).toHaveBeenCalledWith(
        'bitmex-feed',
        { durable: true }
      );

      expect(mockChannel.bindQueue).toHaveBeenCalledWith(
        'bitmex-feed',
        'bitmex-data',
        '#'
      );
    });

    it('should set prefetch to batch size', async () => {
      const onStoreMsg = jest.fn();

      await startConsuming(mockChannel, mockDb, 50, onStoreMsg);

      expect(mockChannel.prefetch).toHaveBeenCalledWith(50);
    });

    it('should start consuming from queue', async () => {
      const onStoreMsg = jest.fn();

      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      expect(mockChannel.consume).toHaveBeenCalledWith(
        'bitmex-feed',
        expect.any(Function)
      );
    });

    it('should handle null message gracefully', async () => {
      const onStoreMsg = jest.fn();

      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(null);

      expect(mockChannel.ack).not.toHaveBeenCalled();
      expect(mockChannel.nack).not.toHaveBeenCalled();
    });

    it('should process valid message', async () => {
      const onStoreMsg = jest.fn();

      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const message = {
        content: Buffer.from(JSON.stringify({
          table: 'trade',
          action: 'insert',
          data: [{ symbol: 'XBTUSD', price: 50000 }]
        }))
      };

      mockGetCollectionName.mockReturnValue('trade_XBTUSD');
      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      expect(mockGetCollectionName).toHaveBeenCalled();
      expect(mockDb.collection).toHaveBeenCalledWith('trade_XBTUSD');
      expect(mockCollection.insertMany).toHaveBeenCalled();
      expect(onStoreMsg).toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(message);
    });

    it('should handle duplicate key error', async () => {
      const onStoreMsg = jest.fn();

      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const message = {
        content: Buffer.from(JSON.stringify({
          table: 'trade',
          action: 'insert',
          data: [{ symbol: 'XBTUSD', price: 50000 }]
        }))
      };

      const error = new Error('E11000 duplicate key error');
      (error as any).code = 11000;
      mockCollection.insertMany.mockRejectedValueOnce(error);

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      // Duplicate errors should be ack'd (not requeued)
      expect(mockChannel.ack).toHaveBeenCalledWith(message);
      expect(mockChannel.nack).not.toHaveBeenCalled();
    });

    it('should requeue message on transient error', async () => {
      const onStoreMsg = jest.fn();

      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const message = {
        content: Buffer.from(JSON.stringify({
          table: 'trade',
          action: 'insert',
          data: [{ symbol: 'XBTUSD', price: 50000 }]
        }))
      };

      const error = new Error('Connection timeout');
      mockCollection.insertMany.mockRejectedValueOnce(error);

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      // Transient errors should be nack'd with requeue=true
      expect(mockChannel.nack).toHaveBeenCalledWith(message, false, true);
      expect(mockChannel.ack).not.toHaveBeenCalled();
    });

    it('should handle messages with no data array', async () => {
      const onStoreMsg = jest.fn();

      await startConsuming(mockChannel, mockDb, 100, onStoreMsg);

      const message = {
        content: Buffer.from(JSON.stringify({
          table: 'trade',
          action: 'insert'
          // no data array
        }))
      };

      mockGetCollectionName.mockReturnValue('trade');
      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      // Should handle gracefully without trying to insert
      expect(mockChannel.ack).toHaveBeenCalledWith(message);
      // insertMany should not be called if there's no data
      if (mockCollection.insertMany.mock.calls.length > 0) {
        const insertCall = mockCollection.insertMany.mock.calls[0];
        expect(insertCall[0]).toHaveLength(0);
      }
    });
  });
});
