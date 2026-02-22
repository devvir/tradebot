import { vi, describe, it, expect, beforeEach } from 'vitest';
import { connectToQueue } from '../src/rabbitmq';
import type { Config } from '../src/types';

vi.mock('@devvir/rabbitmq', () => ({
  keepAlive: vi.fn(),
}));

import * as brokerModule from '@devvir/rabbitmq';

describe('RabbitMQ setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMockConfig = (): Config => ({
    env: 'testnet',
    realtimeWsUrl: 'wss://testnet.bitmex.com/realtime',
    platformWsUrl: 'wss://testnet.bitmex.com/realtimePlatform',
    realtimeChannels: [],
    platformChannels: [],
    queue: {
      rabbitmqUrl: 'amqp://localhost',
      exchangeName: 'ex.feed',
      queueName: 'q.feed',
      messageTtlMs: 1800000,
    },
    connection: {
      reconnectDelayMs: 5000,
      maxReconnectDelayMs: 60000,
    },
  });

  it('should connect to queue with URL from config', async () => {
    const mockBroker = { declares: vi.fn().mockResolvedValue({}) };
    vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

    const config = createMockConfig();
    await connectToQueue(config);

    expect(brokerModule.keepAlive).toHaveBeenCalledWith(config.queue.rabbitmqUrl);
  });

  it('should declare feed exchange with queue using config names', async () => {
    const mockBroker = { declares: vi.fn().mockResolvedValue({}) };
    vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

    const config = createMockConfig();
    await connectToQueue(config);

    expect(mockBroker.declares).toHaveBeenCalledWith({
      exchanges: {
        [config.queue.exchangeName]: {
          type: 'topic',
          queues: { [config.queue.queueName]: { routingKey: '#' } },
        },
      },
    });
  });

  it('should return the broker instance', async () => {
    const mockBroker = { declares: vi.fn().mockResolvedValue({}) };
    vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

    const config = createMockConfig();
    const broker = await connectToQueue(config);

    expect(broker).toBe(mockBroker);
  });
});


