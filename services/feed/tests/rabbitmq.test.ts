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

  it('should connect to queue with given URL', async () => {
    const mockBroker = { declares: vi.fn().mockResolvedValue({}) };
    vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

    await connectToQueue('amqp://localhost');

    expect(brokerModule.keepAlive).toHaveBeenCalledWith('amqp://localhost');
  });

  it('should declare feed exchange with matching routing', async () => {
    const mockBroker = { declares: vi.fn().mockResolvedValue({}) };
    vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

    await connectToQueue('amqp://localhost');

    expect(mockBroker.declares).toHaveBeenCalledWith({
      exchanges: {
        'bitmex.feed': {
          type: 'topic',
          queues: { 'bitmex.feed': { routingKey: '#' } },
        },
      },
    });
  });

  it('should return the broker instance', async () => {
    const mockBroker = { declares: vi.fn().mockResolvedValue({}) };
    vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

    const broker = await connectToQueue('amqp://localhost');

    expect(broker).toBe(mockBroker);
  });
});


