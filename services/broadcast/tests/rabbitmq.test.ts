import { vi, describe, it, expect, beforeEach } from 'vitest';
import { connectToQueue, EXCHANGE } from '../src/rabbitmq';
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
    workerUuid: '00000000-0000-0000-0000-000000000000',
    realtimeWsUrl: 'wss://testnet.bitmex.com/realtime',
    platformWsUrl: 'wss://testnet.bitmex.com/realtimePlatform',
    realtimeChannels: [],
    platformChannels: [],
    queue: {
      rabbitmqUrl: 'amqp://localhost',
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

  it('should not declare any queues', async () => {
    const mockBroker = { declares: vi.fn().mockResolvedValue({}) };
    vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

    const config = createMockConfig();
    await connectToQueue(config);

    const declaredTopology = mockBroker.declares.mock.calls[0][0];
    expect(declaredTopology.queues).toBeUndefined();
  });
});


