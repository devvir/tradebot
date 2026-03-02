// Pending Review
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('@devvir/rabbitmq', () => ({
  keepAlive: vi.fn(),
}));

import { keepAlive } from '@devvir/rabbitmq';
import { connectToQueue, EXCHANGE } from '../src/rabbitmq';

describe('Reader RabbitMQ', () => {
  afterEach(() => vi.clearAllMocks());

  // ── connectToQueue ─────────────────────────────────────────────────────────

  describe('connectToQueue', () => {
    const mockBroker = () => ({ declares: vi.fn().mockResolvedValue({}) });

    it('declares a topic exchange named "reader"', async () => {
      const broker = mockBroker();
      vi.mocked(keepAlive).mockResolvedValueOnce(broker as any);

      await connectToQueue('amqp://localhost');

      const spec = broker.declares.mock.calls[0][0];
      expect(spec.exchanges[EXCHANGE]).toBeDefined();
      expect(spec.exchanges[EXCHANGE].type).toBe('topic');
    });

    it('does not declare any queues — topology is owned by downstream', async () => {
      const broker = mockBroker();
      vi.mocked(keepAlive).mockResolvedValueOnce(broker as any);

      await connectToQueue('amqp://localhost');

      const spec = broker.declares.mock.calls[0][0];
      expect(spec.queues).toBeUndefined();
      expect(spec.exchanges[EXCHANGE].queues).toBeUndefined();
    });
  });
});
