import Dockerode from 'dockerode';
import { fmtBytes, fmtUptime, fmtAgo } from '../../shared/utils/format';
import type { ContainerRow } from './types';

export function cpuPercent(stats: any): string {
  try {
    const cpuDelta =
      stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const sysDelta =
      stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpus =
      stats.cpu_stats.online_cpus ?? stats.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
    if (sysDelta <= 0 || cpuDelta < 0) return '0.00%';
    return `${((cpuDelta / sysDelta) * cpus * 100).toFixed(2)}%`;
  } catch {
    return 'N/A';
  }
}

function memUsage(stats: any): string {
  try {
    const cache = stats.memory_stats.stats?.cache ?? 0;
    const used = stats.memory_stats.usage - cache;
    const limit = stats.memory_stats.limit;

    if (! Number.isFinite(used) || ! Number.isFinite(limit)) return '- / -';

    const pct = limit > 0 ? ((used / limit) * 100).toFixed(1) : '?';

    return `${fmtBytes(used)} / ${fmtBytes(limit)} (${pct}%)`;
  } catch {
    return '- / -';
  }
}

function extractLogTimestamp(buf: Buffer): string {
  try {
    // Docker multiplexed stream: 8-byte header (stream type + size) + message
    const raw = buf.length > 8 && (buf[0] === 1 || buf[0] === 2) ? buf.slice(8) : buf;
    const text = raw.toString('utf8');
    const match = text.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/);
    return match ? fmtAgo(match[1]) : 'N/A';
  } catch {
    return 'N/A';
  }
}

export async function fetchContainerRows(docker: Dockerode): Promise<ContainerRow[]> {
  const containers = await docker.listContainers({ all: false });

  return Promise.all(
    containers.map(async (c): Promise<ContainerRow> => {
      const labels = c.Labels || {};
      const project = labels['com.docker.compose.project'] || '(standalone)';
      const name = (c.Names?.[0] ?? c.Id).replace(/^\//, '');
      const id = c.Id.slice(0, 12);
      const isRunning = c.State === 'running';

      let health = '—';
      if (c.Status.includes('healthy')) health = '\x1b[32m✓ healthy\x1b[0m';
      else if (c.Status.includes('unhealthy')) health = '\x1b[31m✗ unhealthy\x1b[0m';
      else if (c.Status.includes('starting')) health = '\x1b[33m⟳ starting\x1b[0m';

      const uptime = isRunning ? fmtUptime(c.Created) : 'stopped';

      let cpu = '—';
      let mem = '—';
      let lastLog = '—';
      let restarts = '—';

      if (isRunning) {
        const container = docker.getContainer(c.Id);

        const [statsRes, logRes, inspectRes] = await Promise.allSettled([
          new Promise<any>((resolve, reject) =>
            container.stats({ stream: false } as any, (err: any, data: any) =>
              err ? reject(err) : resolve(data),
            ),
          ),
          container.logs({
            stdout: true,
            stderr: true,
            tail: 1,
            timestamps: true,
            follow: false,
          }) as Promise<Buffer>,
          container.inspect(),
        ]);

        if (statsRes.status === 'fulfilled') {
          cpu = cpuPercent(statsRes.value);
          mem = memUsage(statsRes.value);
        }

        if (logRes.status === 'fulfilled') {
          lastLog = extractLogTimestamp(logRes.value as Buffer);
        }

        if (inspectRes.status === 'fulfilled') {
          restarts = String(inspectRes.value.RestartCount ?? 0);
        }
      }

      return { project, id, name, status: c.State, health, uptime, cpu, mem, restarts, lastLog };
    }),
  );
}
