import { publishToQueue } from '../src/rabbitmq';

// Mock amqplib
jest.mock('amqplib');

describe('RabbitMQ utilities', () => {
  let mockChannel: any;

  beforeEach(() => {
    mockChannel = {
      assertExchange: jest.fn().mockResolvedValue({}),
      publish: jest.fn()
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('publishToQueue', () => {
    it('should publish message to exchange with routing key', async () => {
      const data = {
        table: 'trade',
        action: 'insert',
        data: [{ symbol: 'XBTUSD', price: 50000 }],
        _apiVersion: '2.0.0'
      };

      await publishToQueue(mockChannel, data);

      expect(mockChannel.assertExchange).toHaveBeenCalledWith(
        'bitmex-data',
        'topic',
        { durable: true }
      );

      expect(mockChannel.publish).toHaveBeenCalled();
      const publishCall = mockChannel.publish.mock.calls[0];
      expect(publishCall[0]).toBe('bitmex-data');
      expect(publishCall[1]).toBe('trade'); // routing key is the table name
      expect(publishCall[3]).toEqual({ persistent: true });

      // Check message content
      const messageBuffer = publishCall[2];
      const message = JSON.parse(messageBuffer.toString());
      expect(message.table).toBe('trade');
      expect(message._apiVersion).toBe('2.0.0');
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
      const data = { table: 'quote', action: 'update' };

      await publishToQueue(mockChannel, data);

      const publishCall = mockChannel.publish.mock.calls[0];
      expect(publishCall[3].persistent).toBe(true);
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
  });
});
