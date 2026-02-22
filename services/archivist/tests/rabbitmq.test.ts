import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { connectToQueue } from '../src/rabbitmq';
import type { Config } from '../src/types';

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

  const createMockConfig = (): Config => ({
    mongodbUrl: 'mongodb://localhost:27017/test',
    rabbitmqUrl: 'amqp://localhost',
    exchangeName: 'ex.archive',
    queueName: 'q.archive',
    batchSize: 100,
    batchTimeoutMs: 5000,
  });

  describe('connectToQueue', () => {
    it('should initialize broker and declare topology', async () => {
      const mockBroker = {
        declares: vi.fn().mockResolvedValue({}),
      };

      vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

      const config = createMockConfig();
      const broker = await connectToQueue(config);

      expect(brokerModule.keepAlive).toHaveBeenCalledWith(config.rabbitmqUrl);
      expect(mockBroker.declares).toHaveBeenCalled();
      expect(broker).toBe(mockBroker);
    });

    it('should declare archivist queue to consume messages from codec', async () => {
      const mockBroker = {
        declares: vi.fn().mockResolvedValue({}),
      };

      vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

      const config = createMockConfig();
      await connectToQueue(config);

      const declareCall = mockBroker.declares.mock.calls[0][0];
      expect(declareCall.exchanges[config.exchangeName].queues[config.queueName]).toBeDefined();
    });

    it('should ensure queue is durable for reliability', async () => {
      const mockBroker = {
        declares: vi.fn().mockResolvedValue({}),
      };

      vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

      const config = createMockConfig();
      const broker = await connectToQueue(config);

      // Verify topology was declared with expected configuration
      expect(mockBroker.declares).toHaveBeenCalled();

      // Verify the queue is included in the declared topology
      const declareCall = mockBroker.declares.mock.calls[0][0];
      const queueSpec = declareCall.exchanges[config.exchangeName].queues[config.queueName];
      expect(queueSpec).toBeDefined();

      // Observable behavior: since no explicit durable: false, queue defaults to durable
      // This is verifiable by checking that durable is either undefined or true
      expect(queueSpec.durable === undefined || queueSpec.durable === true).toBe(true);
    });
  });
});

