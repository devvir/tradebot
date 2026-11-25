import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { connect, discoverService, info } = vi.hoisted(() => ({
  connect: vi.fn(),
  discoverService: vi.fn(),
  info: vi.fn(),
}));

vi.mock('amqplib', () => ({ default: { connect } }));
vi.mock('../../../src/shared/utils/service-discovery', () => ({ discoverService }));
vi.mock('../../../src/shared/ui/logger', () => ({ info, success: vi.fn() }));

import { connectRabbit, amqpUrl, redactUrl } from '../../../src/shared/connections/rabbitmq';

const ENV_KEYS = ['QUEUE_URL', 'QUEUE_USER', 'QUEUE_PASS', 'QUEUE_MGMT_PORT', 'RABBITMQ_MGMT_URL'];

/** discoverService as it behaves for real: builds the URL with the caller's builder. */
function discovers(ports: Record<number, number>, name = 'rabbitmq') {
  discoverService.mockImplementation(async (_svc: string, build: (h: string, p: number) => string, internal: number) => {
    const port = ports[internal];

    return port ? { name, host: 'localhost', port, url: build('localhost', port), ports } : null;
  });
}

describe('connectRabbit', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }

    connect.mockReset().mockResolvedValue({ createChannel: vi.fn().mockResolvedValue({}) });
    discoverService.mockReset().mockResolvedValue(null);
    info.mockReset();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('connects to the published AMQP port of a discovered container, with its published management port', async () => {
    process.env.QUEUE_USER = 'bot';
    process.env.QUEUE_PASS = 'secret';
    discovers({ 15672: 32772, 5672: 32771 });

    const rabbit = await connectRabbit();

    expect(discoverService).toHaveBeenCalledWith('rabbitmq', expect.any(Function), 5672);
    expect(connect).toHaveBeenCalledWith('amqp://bot:secret@localhost:32771');
    expect(rabbit.mgmtUrl).toBe('http://localhost:32772/api');
    expect(Buffer.from(rabbit.mgmtAuth, 'base64').toString()).toBe('bot:secret');
  });

  it('leaves the management API unset, with a reason, when the container does not publish 15672', async () => {
    process.env.RABBITMQ_MGMT_URL = 'http://elsewhere:15672/api';
    discovers({ 5672: 32771 });

    const rabbit = await connectRabbit();

    expect(rabbit.mgmtUrl).toBeUndefined();
    expect(rabbit.mgmtUnavailable).toMatch(/rabbitmq does not publish the management port 15672/);
  });

  it('uses a --url override unchanged, without discovering', async () => {
    discovers({ 15672: 32772, 5672: 32771 });

    const rabbit = await connectRabbit({ url: 'amqp://u:p@broker.lan:5673' });

    expect(discoverService).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith('amqp://u:p@broker.lan:5673');
    expect(rabbit.mgmtUrl).toBe('http://broker.lan:15672/api');
    expect(Buffer.from(rabbit.mgmtAuth, 'base64').toString()).toBe('u:p');
  });

  it('uses a QUEUE_URL the shell exported unchanged, without discovering', async () => {
    process.env.QUEUE_URL = 'amqp://u:p@broker.lan:5673';
    discovers({ 15672: 32772, 5672: 32771 });

    await connectRabbit();

    expect(discoverService).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith('amqp://u:p@broker.lan:5673');
    expect(info.mock.calls[0][0]).toContain('QUEUE_URL');
  });

  it('logs the discovered container as the source', async () => {
    discovers({ 5672: 32771 }, 'tradebot-rabbitmq-1');

    await connectRabbit();

    expect(info.mock.calls[0][0]).toContain('discovered container tradebot-rabbitmq-1');
  });

  it('without a container, builds the default URL from QUEUE_USER and QUEUE_PASS', async () => {
    process.env.QUEUE_USER = 'bot';
    process.env.QUEUE_PASS = 'secret';

    const rabbit = await connectRabbit();

    expect(connect).toHaveBeenCalledWith('amqp://bot:secret@localhost:5672');
    expect(rabbit.mgmtUrl).toBe('http://localhost:15672/api');
  });

  it('without a container, takes the management API from RABBITMQ_MGMT_URL, then QUEUE_MGMT_PORT', async () => {
    process.env.QUEUE_MGMT_PORT = '25672';
    expect((await connectRabbit({ url: 'amqp://h.lan:5672' })).mgmtUrl).toBe('http://h.lan:25672/api');

    process.env.RABBITMQ_MGMT_URL = 'http://mgmt.lan:8080/api/';
    expect((await connectRabbit({ url: 'amqp://h.lan:5672' })).mgmtUrl).toBe('http://mgmt.lan:8080/api');
  });

  it('never logs the password', async () => {
    process.env.QUEUE_PASS = 'hunter2';
    discovers({ 5672: 32771 });

    await connectRabbit();

    const logged = info.mock.calls.map(c => String(c[0])).join('\n');

    expect(logged).not.toContain('hunter2');
    expect(logged).toContain('***');
  });
});

describe('amqpUrl', () => {
  it('encodes credentials so they round-trip through URL parsing', () => {
    const url = new URL(amqpUrl('us@er', 'p/a#s@s:%', 'localhost', 5672));

    expect(decodeURIComponent(url.username)).toBe('us@er');
    expect(decodeURIComponent(url.password)).toBe('p/a#s@s:%');
    expect(url.hostname).toBe('localhost');
    expect(url.port).toBe('5672');
  });
});

describe('redactUrl', () => {
  it('replaces the password and keeps the rest', () => {
    expect(redactUrl(amqpUrl('bot', 'p/a#s@s', 'localhost', 5672))).toBe('amqp://bot:***@localhost:5672');
  });

  it('leaves a URL without a password as it is', () => {
    expect(redactUrl('amqp://localhost:5672')).toBe('amqp://localhost:5672');
  });
});
