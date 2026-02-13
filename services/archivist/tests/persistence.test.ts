import { startConsuming } from '../src/persistence';
import * as mongodb from '../src/mongodb';

jest.mock('../src/mongodb');
jest.mock('amqplib');

const mockGetCollectionName = mongodb.getCollectionName as jest.MockedFunction<
  typeof mongodb.getCollectionName
>;
const mockExtractMinimalAttributes = mongodb.extractMinimalAttributes as jest.MockedFunction<
  typeof mongodb.extractMinimalAttributes
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
    mockExtractMinimalAttributes.mockReturnValue({
      symbol: 'XBTUSD',
      price: 50000,
      timestamp: Date.now(),
      _apiVersion: '2.0.0'
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('startConsuming', () => {
    it('should setup exchange, queue, and binding', async () => {
      const onMessageProcessed = jest.fn();

      await startConsuming(mockChannel, mockDb, 100, onMessageProcessed);

      expect(mockChannel.assertExchange).toHaveBeenCalledWith(
        'bitmex-data',
        'topic',
        { durable: true }
      );

      expect(mockChannel.assertQueue).toHaveBeenCalledWith(
        'bitmex-data-worker',
        { durable: true }
      );

      expect(mockChannel.bindQueue).toHaveBeenCalledWith(
        'bitmex-data-worker',
        'bitmex-data',
        '#'
      );
    });

    it('should set prefetch to batch size', async () => {
      const onMessageProcessed = jest.fn();

      await startConsuming(mockChannel, mockDb, 50, onMessageProcessed);

      expect(mockChannel.prefetch).toHaveBeenCalledWith(50);
    });

    it('should start consuming from queue', async () => {
      const onMessageProcessed = jest.fn();

      await startConsuming(mockChannel, mockDb, 100, onMessageProcessed);

      expect(mockChannel.consume).toHaveBeenCalledWith(
        'bitmex-data-worker',
        expect.any(Function)
      );
    });

    it('should handle null message gracefully', async () => {
      const onMessageProcessed = jest.fn();

      await startConsuming(mockChannel, mockDb, 100, onMessageProcessed);

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(null);

      expect(mockChannel.ack).not.toHaveBeenCalled();
      expect(mockChannel.nack).not.toHaveBeenCalled();
    });

    it('should process valid message', async () => {
      const onMessageProcessed = jest.fn();

      await startConsuming(mockChannel, mockDb, 100, onMessageProcessed);

      const message = {
        content: Buffer.from(JSON.stringify({
          table: 'trade',
          action: 'insert',
          data: [{ symbol: 'XBTUSD', price: 50000 }],
          _apiVersion: '2.0.0'
        }))
      };

      mockGetCollectionName.mockReturnValue('trade_XBTUSD');
      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      expect(mockGetCollectionName).toHaveBeenCalled();
      expect(mockDb.collection).toHaveBeenCalledWith('trade_XBTUSD');
      expect(mockExtractMinimalAttributes).toHaveBeenCalled();
      expect(mockCollection.insertMany).toHaveBeenCalled();
      expect(onMessageProcessed).toHaveBeenCalled();
      expect(mockChannel.ack).toHaveBeenCalledWith(message);
    });

    it('should include API version in stored documents', async () => {
      const onMessageProcessed = jest.fn();

      await startConsuming(mockChannel, mockDb, 100, onMessageProcessed);

      const message = {
        content: Buffer.from(JSON.stringify({
          table: 'quote',
          action: 'insert',
          data: [{ symbol: 'ETHUSD', bidPrice: 2500 }],
          _apiVersion: '2.0.0'
        }))
      };

      mockGetCollectionName.mockReturnValue('quote_ETHUSD');
      mockExtractMinimalAttributes.mockReturnValue({
        symbol: 'ETHUSD',
        bidPrice: 2500,
        timestamp: Date.now(),
        _apiVersion: '2.0.0'
      });

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      // Verify extractMinimalAttributes was called with API version
      expect(mockExtractMinimalAttributes).toHaveBeenCalledWith(
        expect.objectContaining({ symbol: 'ETHUSD' }),
        '2.0.0'
      );

      // Verify the returned document includes API version
      expect(mockCollection.insertMany).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ _apiVersion: '2.0.0' })
        ]),
        { ordered: false }
      );
    });

    it('should handle duplicate key error', async () => {
      const onMessageProcessed = jest.fn();

      await startConsuming(mockChannel, mockDb, 100, onMessageProcessed);

      const message = {
        content: Buffer.from(JSON.stringify({
          table: 'trade',
          action: 'insert',
          data: [{ symbol: 'XBTUSD', price: 50000 }]
        }))
      };

      const error = new Error('E11000 duplicate key error');
      (error as any).code = 'E11000';
      mockCollection.insertMany.mockRejectedValueOnce(error);

      const consumeCallback = mockChannel.consume.mock.calls[0][1];
      await consumeCallback(message);

      // Duplicate errors should be ack'd (not requeued)
      expect(mockChannel.ack).toHaveBeenCalledWith(message);
      expect(mockChannel.nack).not.toHaveBeenCalled();
    });

    it('should requeue message on transient error', async () => {
      const onMessageProcessed = jest.fn();

      await startConsuming(mockChannel, mockDb, 100, onMessageProcessed);

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
      const onMessageProcessed = jest.fn();

      await startConsuming(mockChannel, mockDb, 100, onMessageProcessed);

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
