import { describe, it, expect, beforeEach, vi } from 'vitest';

const { listContainers } = vi.hoisted(() => ({ listContainers: vi.fn() }));

vi.mock('dockerode', () => ({
  default: class {
    listContainers = listContainers;
  },
}));

vi.mock('../../../src/shared/ui/prompts', () => ({ selectFromList: vi.fn() }));

import { discoverService } from '../../../src/shared/utils/service-discovery';

/** The ports rabbitmq:management exposes, with compose publishing 5672 and 15672 on ephemeral ports. */
const rabbit = {
  Id: 'abcdef1234567890',
  Names: ['/rabbitmq'],
  Image: 'rabbitmq:3.12-management',
  Ports: [
    { PrivatePort: 4369, Type: 'tcp' },
    { PrivatePort: 15672, PublicPort: 32772, Type: 'tcp', IP: '0.0.0.0' },
    { PrivatePort: 5672, PublicPort: 32771, Type: 'tcp', IP: '0.0.0.0' },
    { PrivatePort: 5672, PublicPort: 32771, Type: 'tcp', IP: '::' },
    { PrivatePort: 25672, Type: 'tcp' },
  ],
};

describe('discoverService', () => {
  beforeEach(() => {
    listContainers.mockReset();
  });

  it('returns the host port the requested container port is published on, whatever the order', async () => {
    listContainers.mockResolvedValue([rabbit]);

    const result = await discoverService('rabbitmq', (h, p) => `amqp://${h}:${p}`, 5672);

    expect(result).toMatchObject({ name: 'rabbitmq', host: 'localhost', port: 32771, url: 'amqp://localhost:32771' });
  });

  it('maps every published binding, and only those', async () => {
    listContainers.mockResolvedValue([rabbit]);

    const result = await discoverService('rabbitmq', undefined, 5672);

    expect(result?.ports).toEqual({ 15672: 32772, 5672: 32771 });
  });

  it('skips a container that does not publish the requested port', async () => {
    listContainers.mockResolvedValue([{ ...rabbit, Ports: [{ PrivatePort: 5672, Type: 'tcp' }] }]);

    expect(await discoverService('rabbitmq', undefined, 5672)).toBeNull();
  });

  it('without a requested port, takes the first published binding rather than the first listed', async () => {
    listContainers.mockResolvedValue([rabbit]);

    expect((await discoverService('rabbitmq'))?.port).toBe(32772);
  });

  it('returns null when Docker is unavailable', async () => {
    listContainers.mockRejectedValue(new Error('connect ENOENT /var/run/docker.sock'));

    expect(await discoverService('rabbitmq', undefined, 5672)).toBeNull();
  });
});
