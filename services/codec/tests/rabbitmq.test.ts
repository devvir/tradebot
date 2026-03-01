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
    rabbitmqUrl: 'amqp://user:pass@broker:5672',
    inboundQueue: 'codec.in',
    outboundExchange: 'codec',
    prefetch: 1000,
  });

  it('should connect using the URL from config', async () => {
    const mockBroker = { declares: vi.fn().mockResolvedValue({}) };
    vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

    const config = createMockConfig();

    await connectToQueue(config);

    expect(brokerModule.keepAlive).toHaveBeenCalledWith(config.rabbitmqUrl);
  });
});


