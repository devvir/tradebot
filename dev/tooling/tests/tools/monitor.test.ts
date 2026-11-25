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

/** A restart reuses the container, so its creation time says nothing about how long it has been up. */
describe('uptime', () => {
  it('counts from the last start, not from when the container was created', async () => {
    const { fetchContainerRows } = await import('../../src/tools/monitor/docker');
    const started = new Date(Date.now() - 5 * 60_000 - 10_000).toISOString();

    const docker = {
      listContainers: async () => [mockContainerList[1]],
      getContainer:   () => ({
        stats:   (_options: unknown, done: (err: unknown, data: unknown) => void) => done(null, mockStats),
        logs:    async () => Buffer.from(''),
        inspect: async () => ({ RestartCount: 0, State: { StartedAt: started } }),
      }),
    };

    const [row] = await fetchContainerRows(docker as never);

    expect(row!.uptime).toMatch(/^5m \d+s$/);
  });
});

describe('health', () => {
  const rowFor = async (status: string) => {
    const { fetchContainerRows } = await import('../../src/tools/monitor/docker');
    const docker = {
      listContainers: async () => [{ ...mockContainerList[1], Status: status }],
      getContainer:   () => ({
        stats:   (_options: unknown, done: (err: unknown, data: unknown) => void) => done(null, mockStats),
        logs:    async () => Buffer.from(''),
        inspect: async () => ({ RestartCount: 0, State: {} }),
      }),
    };
    const [row] = await fetchContainerRows(docker as never);
    return row!.health;
  };

  it('shows a failing healthcheck as unhealthy', async () => {
    expect(await rowFor('Up 2 hours (unhealthy)')).toBe('\x1b[31m✗ unhealthy\x1b[0m');
  });

  it('shows a healthcheck that has not reported yet as starting', async () => {
    expect(await rowFor('Up 5 seconds (health: starting)')).toBe('\x1b[33m⟳ starting\x1b[0m');
  });

  it('shows a passing healthcheck as healthy', async () => {
    expect(await rowFor('Up 1 hour (healthy)')).toBe('\x1b[32m✓ healthy\x1b[0m');
  });

  it('shows a dash for a container without a healthcheck', async () => {
    expect(await rowFor('Up 1 hour')).toBe('—');
  });
});

describe('parseInterval', () => {
  it('accepts whole and fractional seconds', async () => {
    const { parseInterval } = await import('../../src/tools/monitor/index');
    expect(parseInterval('3')).toBe(3);
    expect(parseInterval('0.5')).toBe(0.5);
    expect(parseInterval(2)).toBe(2);
    expect(parseInterval(undefined)).toBe(3);
  });

  it.each(['0', '0.25', '-1', 'x', '', '1s', 'Infinity'])('refuses %j', async (raw) => {
    const { parseInterval } = await import('../../src/tools/monitor/index');
    expect(() => parseInterval(raw)).toThrow(/Invalid interval/);
  });
});

describe('startLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never runs two ticks at once and waits the interval after each one finishes', async () => {
    const { startLoop } = await import('../../src/tools/monitor/index');
    let running = 0;
    let maxRunning = 0;
    const starts: number[] = [];

    const tick = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      starts.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 2500));
      running--;
    };

    const start = Date.now();
    const stop = startLoop(tick, 1000, () => {});

    await vi.advanceTimersByTimeAsync(10_000);
    stop();

    expect(maxRunning).toBe(1);
    // Each run takes 2.5 s and the next starts 1 s after it ends.
    expect(starts.map((t) => t - start)).toEqual([0, 3500, 7000]);
  });

  it('keeps going after a tick throws', async () => {
    const { startLoop } = await import('../../src/tools/monitor/index');
    let calls = 0;
    const errors: unknown[] = [];

    const stop = startLoop(async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
    }, 1000, (err) => errors.push(err));

    await vi.advanceTimersByTimeAsync(2500);
    stop();

    expect(calls).toBe(3);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');
  });

  it('stops scheduling once stopped', async () => {
    const { startLoop } = await import('../../src/tools/monitor/index');
    let calls = 0;

    const stop = startLoop(async () => { calls++; }, 1000, () => {});
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(calls).toBe(1);
  });
});

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

  it('returns 0.00% when the previous sample has no system usage', async () => {
    const { cpuPercent } = await import('../../src/tools/monitor/docker');
    const stats = {
      cpu_stats: { cpu_usage: { total_usage: 2000 }, system_cpu_usage: 5000, online_cpus: 2 },
      precpu_stats: { cpu_usage: { total_usage: 1000 } },
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
    process.env.QUEUE_USER = 'testuser';
    process.env.QUEUE_PASS = 'testpass';
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

describe('buildOutput', () => {
  const row = (name: string, project: string) => ({
    project, id: 'abc123def456', name, status: 'running', health: '—', uptime: '1m 0s',
    cpu: '0.00%', mem: '- / -', restarts: '0', lastLog: 'N/A',
  });

  it('escapes control characters in names and errors from Docker and the brokers, keeping its own colours', async () => {
    const { buildOutput } = await import('../../src/tools/monitor/render');

    const output = buildOutput(
      [row('svc\x1b]0;pwned\x07', 'proj\x1b[2J')],
      new Map([['rabbit\x1b[H', [{
        instance: 'rabbit\x1b[H', name: 'q\x1b[31m', vhost: '/\x9b', ready: 0, unacked: 0, total: 0,
        consumers: 0, publishRate: '0.0/s', deliverRate: '0.0/s', state: 'f\x1b[K',
      }]]]),
      new Map([['broken\x1b[H', 'boom\x1b[2J']]),
      new Map(),
      3,
      new Date(),
      'docker\x1b[2J',
    );

    for (const shown of ['svc\\x1b]0;pwned\\x07', 'proj\\x1b[2J', 'rabbit\\x1b[H', 'q\\x1b[31m', '/\\x9b',
      'f\\x1b[K', 'broken\\x1b[H', 'boom\\x1b[2J', 'docker\\x1b[2J']) {
      expect(output).toContain(shown);
    }

    expect(output).not.toMatch(/\x1b\[(2J|H|K)|\x1b\]0|\x07|\x9b/);
    expect(output).toContain('\x1b[1m TradeBot Monitor\x1b[0m');
  });
});
