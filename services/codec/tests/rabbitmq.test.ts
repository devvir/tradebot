import { vi, describe, it, expect, beforeEach } from 'vitest';
import { connectToQueue } from '../src/rabbitmq';

vi.mock('@tradebot/logger', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@devvir/rabbitmq', () => ({
  keepAlive: vi.fn(),
}));

import * as brokerModule from '@devvir/rabbitmq';

describe('RabbitMQ setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should connect using the provided URL', async () => {
    const mockBroker = { declares: vi.fn().mockReturnThis() };
    vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

    await connectToQueue('amqp://user:pass@broker:5672');

    expect(brokerModule.keepAlive).toHaveBeenCalledWith('amqp://user:pass@broker:5672');
  });

  it('should return the broker instance', async () => {
    const mockBroker = { declares: vi.fn().mockReturnThis() };
    vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

    const broker = await connectToQueue('amqp://localhost');

    expect(broker).toBe(mockBroker);
  });

  it('should declare bitmex.feed exchange as topic with bitmex.feed queue bound to all routing keys', async () => {
    const mockBroker = { declares: vi.fn().mockReturnThis() };
    vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

    await connectToQueue('amqp://localhost');

    const topology = mockBroker.declares.mock.calls[0][0];
    expect(topology.exchanges['bitmex.feed'].type).toBe('topic');
    expect(topology.exchanges['bitmex.feed'].queues['bitmex.feed'].routingKey).toBe('#');
  });

  it('should declare archivist output queue on the default exchange', async () => {
    const mockBroker = { declares: vi.fn().mockReturnThis() };
    vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

    await connectToQueue('amqp://localhost');

    const topology = mockBroker.declares.mock.calls[0][0];
    expect(topology.queues['archivist']).toBeDefined();
  });
});


