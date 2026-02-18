import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { connectToQueue } from '../src/rabbitmq';

// Mock the broker module
vi.mock('../../../packages/rabbitmq', () => ({
  keepAlive: vi.fn(),
}));

// Import after mock
import * as brokerModule from '../../../packages/rabbitmq';

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
        declares: vi.fn().mockResolvedValue({}),
      };

      vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

      const broker = await connectToQueue('amqp://localhost');

      expect(brokerModule.keepAlive).toHaveBeenCalledWith('amqp://localhost');
      expect(mockBroker.declares).toHaveBeenCalled();
      expect(broker).toBe(mockBroker);
    });

    it('should declare archivist queue to consume messages from codec', async () => {
      const mockBroker = {
        declares: vi.fn().mockResolvedValue({}),
      };

      vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

      await connectToQueue('amqp://localhost');

      const declareCall = mockBroker.declares.mock.calls[0][0];
      expect(declareCall.queues['archivist']).toBeDefined();
      expect(declareCall.queues['archivist'].durable).toBe(true);
    });

    it('should ensure queue is durable for reliability', async () => {
      const mockBroker = {
        declares: vi.fn().mockResolvedValue({}),
      };

      vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

      await connectToQueue('amqp://localhost');

      const declareCall = mockBroker.declares.mock.calls[0][0];
      expect(declareCall.queues['archivist'].durable).toBe(true);
    });
  });
});

