// Pending Review
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { connectToQueue } from '../src/rabbitmq';
import { CONSUMER_QUEUES, DLQ, DLX, EXCHANGE } from '../src/types';
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
    dbArchive: 'tradebot_archive',
    dbCollect: 'tradebot_collect',
    prefetch: 100,
    insertBatchSize: 100,
    flushIntervalMs: 50,
  });

  describe('connectToQueue', () => {
    it('should declare a topic exchange named "writer"', async () => {
      const mockBroker = {
        declares: vi.fn().mockResolvedValue({}),
      };

      vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

      await connectToQueue(createMockConfig());

      const declareCall = mockBroker.declares.mock.calls[0][0];
      expect(declareCall.exchanges[EXCHANGE]).toBeDefined();
      expect(declareCall.exchanges[EXCHANGE].type).toBe('topic');
    });

    it('should declare a fanout DLX with a dead-letter queue', async () => {
      const mockBroker = {
        declares: vi.fn().mockResolvedValue({}),
      };

      vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

      await connectToQueue(createMockConfig());

      const declareCall = mockBroker.declares.mock.calls[0][0];
      expect(declareCall.exchanges[DLX]).toBeDefined();
      expect(declareCall.exchanges[DLX].type).toBe('fanout');
      expect(declareCall.exchanges[DLX].queues[DLQ]).toBeDefined();
    });

    it('should declare archive queue bound to archive.*', async () => {
      const mockBroker = {
        declares: vi.fn().mockResolvedValue({}),
      };

      vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

      await connectToQueue(createMockConfig());

      const queues = mockBroker.declares.mock.calls[0][0].exchanges[EXCHANGE].queues;
      expect(queues[CONSUMER_QUEUES.archive]).toBeDefined();
      expect(queues[CONSUMER_QUEUES.archive].routingKey).toBe('archive.*');
      expect(queues[CONSUMER_QUEUES.archive].deadLetterExchange).toBe(DLX);
    });

    it('should declare collect queue bound to collect.*', async () => {
      const mockBroker = {
        declares: vi.fn().mockResolvedValue({}),
      };

      vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

      await connectToQueue(createMockConfig());

      const queues = mockBroker.declares.mock.calls[0][0].exchanges[EXCHANGE].queues;
      expect(queues[CONSUMER_QUEUES.collect]).toBeDefined();
      expect(queues[CONSUMER_QUEUES.collect].routingKey).toBe('collect.*');
      expect(queues[CONSUMER_QUEUES.collect].deadLetterExchange).toBe(DLX);
    });

    it('should declare custom queue bound to custom.*.*', async () => {
      const mockBroker = {
        declares: vi.fn().mockResolvedValue({}),
      };

      vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

      await connectToQueue(createMockConfig());

      const queues = mockBroker.declares.mock.calls[0][0].exchanges[EXCHANGE].queues;
      expect(queues[CONSUMER_QUEUES.custom]).toBeDefined();
      expect(queues[CONSUMER_QUEUES.custom].routingKey).toBe('custom.*.*');
      expect(queues[CONSUMER_QUEUES.custom].deadLetterExchange).toBe(DLX);
    });
  });
});

