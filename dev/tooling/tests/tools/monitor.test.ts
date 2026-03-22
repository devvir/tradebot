import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ── Axios mock ────────────────────────────────────────────────────────────────

const mockQueues = [
  {
    name: 'broadcast',
    vhost: '/',
    messages_ready: 0,
    messages_unacknowledged: 0,
    messages: 0,
    consumers: 2,
    state: 'running',
    message_stats: { publish_details: { rate: 1.5 }, deliver_details: { rate: 1.2 } },
  },
  {
    name: 'trades',
    vhost: '/',
    messages_ready: 3,
    messages_unacknowledged: 1,
    messages: 4,
    consumers: 1,
    state: 'running',
    message_stats: { publish_details: { rate: 0.5 }, deliver_details: { rate: 0.3 } },
  },
];

vi.mock('axios', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: mockQueues }),
  },
}));

// ── Test data ─────────────────────────────────────────────────────────────────

const mockContainerList = [
  {
    Id: 'abc123def4561234',
    Names: ['/tradebot-rabbitmq'],
    Image: 'rabbitmq:3-management',
    State: 'running',
    Status: 'Up 3 hours (healthy)',
    Created: Math.floor(Date.now() / 1000) - 3 * 3600,
    Labels: { 'com.docker.compose.project': 'tradebot' },
    Ports: [{ PrivatePort: 15672, PublicPort: 19672, Type: 'tcp' }],
  },
  {
    Id: 'def456abc7891234',
    Names: ['/tradebot-writer-1'],
    Image: 'tradebot-writer:latest',
    State: 'running',
    Status: 'Up 2 hours (healthy)',
    Created: Math.floor(Date.now() / 1000) - 2 * 3600,
    Labels: { 'com.docker.compose.project': 'tradebot' },
    Ports: [],
  },
];

const mockStats = {
  cpu_stats: {
    cpu_usage: { total_usage: 2000000 },
    system_cpu_usage: 100000000,
    online_cpus: 4,
  },
  precpu_stats: {
    cpu_usage: { total_usage: 1000000 },
    system_cpu_usage: 95000000,
  },
  memory_stats: {
    usage: 100 * 1024 * 1024,
    limit: 1024 * 1024 * 1024,
    stats: { cache: 0 },
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('cpuPercent', () => {
  it('calculates cpu percentage from stats', async () => {
    const { cpuPercent } = await import('../../src/tools/monitor/docker');
    const result = cpuPercent(mockStats);
    // (1000000 / 5000000) * 4 * 100 = 80.00%
    expect(result).toBe('80.00%');
  });

  it('returns 0.00% when delta is zero', async () => {
    const { cpuPercent } = await import('../../src/tools/monitor/docker');
    const stats = {
      cpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 1000, online_cpus: 1 },
      precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 1000 },
    };
    expect(cpuPercent(stats)).toBe('0.00%');
  });

  it('returns N/A on malformed stats', async () => {
    const { cpuPercent } = await import('../../src/tools/monitor/docker');
    expect(cpuPercent({})).toBe('N/A');
  });
});

describe('discoverRabbitInstances', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RABBITMQ_USER = 'testuser';
    process.env.RABBITMQ_PASS = 'testpass';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('discovers rabbitmq containers with management port mapped', async () => {
    const { discoverRabbitInstances } = await import('../../src/tools/monitor/rabbitmq');
    const docker = { listContainers: vi.fn().mockResolvedValue(mockContainerList) } as any;

    const instances = await discoverRabbitInstances(docker);

    expect(instances).toHaveLength(1);
    expect(instances[0].name).toBe('tradebot-rabbitmq');
    expect(instances[0].project).toBe('tradebot');
    expect(instances[0].mgmtUrl).toBe('http://localhost:19672');
    expect(instances[0].auth.username).toBe('testuser');
    expect(instances[0].auth.password).toBe('testpass');
  });

  it('fetches queues from a discovered instance', async () => {
    const { fetchQueueRows } = await import('../../src/tools/monitor/rabbitmq');
    const rows = await fetchQueueRows({
      name: 'tradebot-rabbitmq',
      project: 'tradebot',
      mgmtUrl: 'http://localhost:19672',
      auth: { username: 'guest', password: 'guest' },
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe('broadcast');
    expect(rows[0].consumers).toBe(2);
    expect(rows[1].name).toBe('trades');
    expect(rows[1].ready).toBe(3);
    expect(rows[1].unacked).toBe(1);
    expect(rows[0].publishRate).toBe('1.5/s');
  });
});
