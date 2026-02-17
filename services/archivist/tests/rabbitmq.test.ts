import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { connectRabbitMQ } from '../src/rabbitmq';
import amqp from 'amqplib';

vi.mock('amqplib', () => ({
  default: {
    connect: vi.fn()
  }
}));

describe('RabbitMQ connection', () => {
  let mockConnection: any;
  let mockChannel: any;

  beforeEach(() => {
    mockChannel = {
      close: vi.fn().mockResolvedValue(undefined)
    };

    mockConnection = {
      createChannel: vi.fn().mockResolvedValue(mockChannel),
      close: vi.fn().mockResolvedValue(undefined),
      on: vi.fn()
    };

    vi.mocked(amqp.connect).mockResolvedValue(mockConnection);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('connectRabbitMQ', () => {
    it('should return a channel and connection object', async () => {
      const result = await connectRabbitMQ('amqp://guest:guest@localhost:5672');

      expect(result).toHaveProperty('channel');
      expect(result).toHaveProperty('connection');
      expect(result.channel).toBe(mockChannel);
      expect(result.connection).toBe(mockConnection);
    });

    it('should handle connection URL', async () => {
      const url = 'amqp://test:pass@rabbitmq:5672';

      const result = await connectRabbitMQ(url);

      expect(amqp.connect).toHaveBeenCalledWith(url);
      expect(result.channel).toBeDefined();
    });
  });
});
