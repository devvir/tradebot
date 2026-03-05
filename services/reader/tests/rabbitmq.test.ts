// Pending Review
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('@devvir/rabbitmq', () => ({
  keepAlive: vi.fn(),
}));

import { keepAlive } from '@devvir/rabbitmq';
import { connectToQueue } from '../src/rabbitmq';

describe('Reader RabbitMQ', () => {
  afterEach(() => vi.clearAllMocks());

  // ── connectToQueue ─────────────────────────────────────────────────────────

  describe('connectToQueue', () => {
    const mockBroker = () => ({ declares: vi.fn().mockResolvedValue({}) });

    const config = { rabbitmqUrl: 'amqp://localhost', database: 'test_db' } as any;

    it('declares a standalone durable queue named "reader.<database>"', async () => {
      const broker = mockBroker();
      vi.mocked(keepAlive).mockResolvedValueOnce(broker as any);

      await connectToQueue(config);

      const spec = broker.declares.mock.calls[0][0];
      expect(spec.queues?.['reader.test_db']).toBeDefined();
    });

    it('does not declare any exchanges', async () => {
      const broker = mockBroker();
      vi.mocked(keepAlive).mockResolvedValueOnce(broker as any);

      await connectToQueue(config);

      const spec = broker.declares.mock.calls[0][0];
      expect(spec.exchanges).toBeUndefined();
    });
  });
});
