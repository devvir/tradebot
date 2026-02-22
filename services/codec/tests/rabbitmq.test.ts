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
    inboundExchange: 'ex.feed',
    inboundQueue: 'q.feed',
    outboundExchange: 'ex.archive',
    outboundQueue: 'q.archive',
  });

  it('should connect using the URL from config', async () => {
    const mockBroker = { declares: vi.fn().mockReturnThis() };
    vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

    const config = createMockConfig();
    await connectToQueue(config);

    expect(brokerModule.keepAlive).toHaveBeenCalledWith(config.rabbitmqUrl);
  });

  it('should return the broker instance', async () => {
    const mockBroker = { declares: vi.fn().mockReturnThis() };
    vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

    const config = createMockConfig();
    const broker = await connectToQueue(config);

    expect(broker).toBe(mockBroker);
  });

  it('should declare inbound exchange as topic with inbound queue bound to all routing keys', async () => {
    const mockBroker = { declares: vi.fn().mockReturnThis() };
    vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

    const config = createMockConfig();
    await connectToQueue(config);

    const topology = mockBroker.declares.mock.calls[0][0];
    expect(topology.exchanges[config.inboundExchange].type).toBe('topic');
    expect(topology.exchanges[config.inboundExchange].queues[config.inboundQueue].routingKey).toBe('#');
  });

  it('should declare outbound exchange and queue based on config', async () => {
    const mockBroker = { declares: vi.fn().mockReturnThis() };
    vi.mocked(brokerModule.keepAlive).mockResolvedValueOnce(mockBroker as any);

    const config = createMockConfig();
    await connectToQueue(config);

    const topology = mockBroker.declares.mock.calls[0][0];
    expect(topology.exchanges[config.outboundExchange]).toBeDefined();
    expect(topology.exchanges[config.outboundExchange].queues[config.outboundQueue]).toBeDefined();
  });
});


