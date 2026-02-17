import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { publishToQueue, connectWithRetry } from '../src/rabbitmq';
import amqp from 'amqplib';

// Mock amqplib
vi.mock('amqplib');

describe('RabbitMQ utilities', () => {
  let mockChannel: any;

  beforeEach(() => {
    mockChannel = {
      assertExchange: vi.fn().mockResolvedValue({}),
      publish: vi.fn(() => true),
      abort: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('publishToQueue', () => {
    it('should publish message with routing key including symbol', async () => {
      const data = {
        table: 'trade',
        action: 'insert',
        data: [{ symbol: 'XBTUSD', price: 50000 }],
        symbol: 'XBTUSD',
        _apiVersion: '2.0.0'
      };

      await publishToQueue(mockChannel, data);

      expect(mockChannel.publish).toHaveBeenCalled();
      const publishCall = mockChannel.publish.mock.calls[0];
      expect(publishCall[0]).toBe('bitmex-data');
      expect(publishCall[1]).toBe('trade.XBTUSD'); // routing key includes symbol
      expect(publishCall[3]).toEqual({ persistent: true });

      // Check message content
      const messageBuffer = publishCall[2];
      const message = JSON.parse(messageBuffer.toString());
      expect(message.table).toBe('trade');
      expect(message._apiVersion).toBe('2.0.0');
    });

    it('should publish message with routing key without symbol when not present', async () => {
      const data = {
        table: 'insurance',
        action: 'insert',
        data: [],
        _apiVersion: '2.0.0'
      };

      await publishToQueue(mockChannel, data);

      const publishCall = mockChannel.publish.mock.calls[0];
      expect(publishCall[1]).toBe('insurance'); // routing key is table only
    });

    it('should handle null channel gracefully', async () => {
      const data = { table: 'trade' };

      // Should not throw
      await publishToQueue(null as any, data);

      expect(mockChannel.publish).not.toHaveBeenCalled();
    });

    it('should extract table name from message as routing key', async () => {
      const data = {
        table: 'orderBookL2',
        action: 'insert',
        data: []
      };

      await publishToQueue(mockChannel, data);

      const publishCall = mockChannel.publish.mock.calls[0];
      expect(publishCall[1]).toBe('orderBookL2');
    });

    it('should publish message with persistent flag', async () => {
      const data = { table: 'quote', action: 'update', data: [] };

      await publishToQueue(mockChannel, data);

      expect(mockChannel.publish).toHaveBeenCalledWith(
        'bitmex-data',
        'quote',
        expect.any(Buffer),
        expect.objectContaining({ persistent: true })
      );
    });

    it('should serialize complex message structures', async () => {
      const data = {
        table: 'trade',
        action: 'insert',
        data: [
          {
            symbol: 'XBTUSD',
            price: 50000,
            size: 100,
            side: 'Buy',
            timestamp: '2026-02-01T12:00:00Z'
          }
        ],
        _apiVersion: '2.0.0'
      };

      await publishToQueue(mockChannel, data);

      const publishCall = mockChannel.publish.mock.calls[0];
      const messageBuffer = publishCall[2];
      const message = JSON.parse(messageBuffer.toString());

      expect(message.data[0].symbol).toBe('XBTUSD');
      expect(message.data[0].price).toBe(50000);
      expect(message._apiVersion).toBe('2.0.0');
    });

    it('should wait for drain when backpressure occurs', async () => {
      vi.useFakeTimers();

      // First publish fails (backpressure), second succeeds
      mockChannel.publish
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);

      const publishPromise = publishToQueue(mockChannel, { table: 'trade', data: [] });

      // Advance timer to trigger safety timeout
      vi.advanceTimersByTime(5000);

      await publishPromise;

      expect(mockChannel.publish).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('should include TTL when provided', async () => {
      const data = { table: 'trade', data: [{ symbol: 'XBTUSD' }] };
      const ttlMs = 60000;

      await publishToQueue(mockChannel, data, ttlMs);

      expect(mockChannel.publish).toHaveBeenCalledWith(
        'bitmex-data',
        'trade.XBTUSD',
        expect.any(Buffer),
        expect.objectContaining({ expiration: '60000' })
      );
    });
  });

  describe('connectWithRetry', () => {
    const mockChannel = {
      assertExchange: vi.fn().mockResolvedValue({}),
      assertQueue: vi.fn().mockResolvedValue({}),
      bindQueue: vi.fn().mockResolvedValue({}),
      setMaxListeners: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
    };

    const mockConnection = {
      createChannel: vi.fn().mockResolvedValue(mockChannel),
      on: vi.fn(),
      once: vi.fn(),
    };

    const mockOnReconnect = vi.fn();
    const mockOnChannelInvalidated = vi.fn();

    beforeEach(() => {
      vi.clearAllMocks();
      (amqp.connect as any).mockClear();
    });

    it('should succeed on first attempt when connection succeeds', async () => {
      (amqp.connect as any).mockResolvedValueOnce(mockConnection);

      const result = await connectWithRetry(
        'amqp://localhost',
        mockOnReconnect,
        mockOnChannelInvalidated,
        3,
        100
      );

      expect(result.connection).toBe(mockConnection);
      expect(result.channel).toBe(mockChannel);
      expect(amqp.connect).toHaveBeenCalledTimes(1);
    });

    it('should retry when initial connection fails', async () => {
      vi.useFakeTimers();

      (amqp.connect as any)
        .mockRejectedValueOnce(new Error('Connection failed'))
        .mockResolvedValueOnce(mockConnection);

      const resultPromise = connectWithRetry(
        'amqp://localhost',
        mockOnReconnect,
        mockOnChannelInvalidated,
        3,
        100
      );

      // Advance through the delay
      await vi.advanceTimersByTimeAsync(100);

      const result = await resultPromise;

      expect(result.connection).toBe(mockConnection);
      expect(amqp.connect).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('should throw after exhausting all retries', async () => {
      (amqp.connect as any).mockRejectedValue(new Error('Connection failed'));

      await expect(
        connectWithRetry(
          'amqp://localhost',
          mockOnReconnect,
          mockOnChannelInvalidated,
          3,
          0 // No delay for faster test
        )
      ).rejects.toThrow('Failed to connect to RabbitMQ after 3 attempts');

      expect(amqp.connect).toHaveBeenCalledTimes(3);
    });

    it('should respect custom maxRetries', async () => {
      (amqp.connect as any).mockRejectedValue(new Error('Connection failed'));

      await expect(
        connectWithRetry(
          'amqp://localhost',
          mockOnReconnect,
          mockOnChannelInvalidated,
          5,
          0 // No delay for faster test
        )
      ).rejects.toThrow('Failed to connect to RabbitMQ after 5 attempts');

      expect(amqp.connect).toHaveBeenCalledTimes(5);
    });

    it('should wait specified delay between retries', async () => {
      vi.useFakeTimers();

      (amqp.connect as any)
        .mockRejectedValueOnce(new Error('Connection failed'))
        .mockResolvedValueOnce(mockConnection);

      const resultPromise = connectWithRetry(
        'amqp://localhost',
        mockOnReconnect,
        mockOnChannelInvalidated,
        3,
        250
      );

      // Should not have retried yet
      expect(amqp.connect).toHaveBeenCalledTimes(1);

      // Advance through the delay
      await vi.advanceTimersByTimeAsync(250);

      await resultPromise;

      // Should have retried after delay
      expect(amqp.connect).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });
});

