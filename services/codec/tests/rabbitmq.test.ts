import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { connectToQueue } from '../src/rabbitmq';

// Mock the broker module
vi.mock('@devvir/rabbitmq', () => ({
  keepAlive: vi.fn(),
}));

// Import after mock
import * as brokerModule from '@devvir/rabbitmq';

describe('RabbitMQ integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('connectToQueue', () => {
    it('should initialize broker and declare topology', async () => {
      const mockBroker = {
        declares: vi.fn().mockReturnThis(),
      };

      vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

      const broker = await connectToQueue('amqp://localhost');

      expect(brokerModule.keepAlive).toHaveBeenCalledWith('amqp://localhost');
      expect(mockBroker.declares).toHaveBeenCalled();
      expect(broker).toBe(mockBroker);
    });

    it('should declare bitmex-data exchange as topic exchange', async () => {
      const mockBroker = {
        declares: vi.fn().mockReturnThis(),
      };

      vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

      await connectToQueue('amqp://localhost');

      const declareCall = mockBroker.declares.mock.calls[0][0];
      expect(declareCall.exchanges['bitmex-data']).toBeDefined();
      expect(declareCall.exchanges['bitmex-data'].type).toBe('topic');
    });

    it('should declare bitmex-feed queue bound to bitmex-data exchange', async () => {
      const mockBroker = {
        declares: vi.fn().mockReturnThis(),
      };

      vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

      await connectToQueue('amqp://localhost');

      const declareCall = mockBroker.declares.mock.calls[0][0];
      expect(declareCall.exchanges['bitmex-data']).toBeDefined();
      expect(declareCall.exchanges['bitmex-data'].queues['bitmex-feed']).toBeDefined();
      expect(declareCall.exchanges['bitmex-data'].queues['bitmex-feed'].routingKey).toBe('#');
    });

    it('should declare archivist queue to publish to storage', async () => {
      const mockBroker = {
        declares: vi.fn().mockReturnThis(),
      };

      vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

      await connectToQueue('amqp://localhost');

      const declareCall = mockBroker.declares.mock.calls[0][0];
      expect(declareCall.queues['archivist']).toBeDefined();
    });

    it('should declare all necessary topology', async () => {
      const mockBroker = {
        declares: vi.fn().mockReturnThis(),
      };

      vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

      await connectToQueue('amqp://localhost');

      const declareCall = mockBroker.declares.mock.calls[0][0];
      expect(declareCall.exchanges['bitmex-data'].type).toBe('topic');
      expect(declareCall.exchanges['bitmex-data'].queues['bitmex-feed'].routingKey).toBe('#');
      expect(declareCall.queues['archivist']).toBeDefined();
    });
  });
});

