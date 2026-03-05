import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { connectToQueue } from '../src/rabbitmq';
import { QUEUE, DLQ, DLX, EXCHANGE } from '../src/rabbitmq';
import type { Config } from '../src/types';

vi.mock('@devvir/rabbitmq', () => ({
  keepAlive: vi.fn(),
}));

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
    prefetch: 100,
    flushIntervalMs: 50,
  });

  const makeMockBroker = () => ({
    declares: vi.fn().mockResolvedValue({}),
  });

  describe('connectToQueue', () => {
    it('should declare a topic exchange named "writer"', async () => {
      const mockBroker = makeMockBroker();
      vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

      await connectToQueue(createMockConfig());

      const declareCall = mockBroker.declares.mock.calls[0][0];
      expect(declareCall.exchanges[EXCHANGE]).toBeDefined();
      expect(declareCall.exchanges[EXCHANGE].type).toBe('topic');
    });

    it('should declare a single catch-all queue bound to "#"', async () => {
      const mockBroker = makeMockBroker();
      vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

      await connectToQueue(createMockConfig());

      const queues = mockBroker.declares.mock.calls[0][0].exchanges[EXCHANGE].queues;
      expect(queues[QUEUE]).toBeDefined();
      expect(queues[QUEUE].routingKey).toBe('#');
      expect(queues[QUEUE].deadLetterExchange).toBe(DLX);
    });

    it('should declare a fanout DLX with a dead-letter queue', async () => {
      const mockBroker = makeMockBroker();
      vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

      await connectToQueue(createMockConfig());

      const declareCall = mockBroker.declares.mock.calls[0][0];
      expect(declareCall.exchanges[DLX]).toBeDefined();
      expect(declareCall.exchanges[DLX].type).toBe('fanout');
      expect(declareCall.exchanges[DLX].queues[DLQ]).toBeDefined();
    });
  });
});
