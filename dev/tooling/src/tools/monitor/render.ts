import Table from 'cli-table3';
import { C } from '../../shared/utils/colors';
import type { ContainerRow, QueueRow } from './types';

function colorUnacked(unacked: number): string {
  if (unacked > 10000) return `${C.red}${unacked}${C.reset}`;
  if (unacked > 1000) return `${C.yellow}${unacked}${C.reset}`;
  return `${C.green}${unacked}${C.reset}`;
}

function colorLastLog(lastLog: string, name: string): string {
  if (/rabbitmq|-in|-out/i.test(name)) return `${C.dim}${lastLog}${C.reset}`;
  const match = lastLog.match(/(\d+)([smhd]) ago/);
  if (! match) return `${C.dim}${lastLog}${C.reset}`;
  const val = parseInt(match[1], 10);
  const unit = match[2];
  let seconds = val;
  if (unit === 'm') seconds *= 60;
  else if (unit === 'h') seconds *= 3600;
  else if (unit === 'd') seconds *= 86400;
  if (seconds > 300) return `${C.red}${lastLog}${C.reset}`;
  if (seconds > 60) return `${C.yellow}${lastLog}${C.reset}`;
  return `${C.dim}${lastLog}${C.reset}`;
}

function colorCpu(cpu: string): string {
  const pct = parseFloat(cpu.replace('%', ''));
  if (isNaN(pct)) return cpu;
  if (pct > 200) return `${C.red}${cpu}${C.reset}`;
  if (pct > 100) return `${C.yellow}${cpu}${C.reset}`;
  return cpu;
}

export function buildOutput(
  containerRows: ContainerRow[],
  queuesByInstance: Map<string, QueueRow[]>,
  rabbitErrors: Map<string, string>,
  interval: number,
  updatedAt: Date,
  errorMsg: string | null,
): string {
  const lines: string[] = [];

  lines.push(
    `${C.bold} TradeBot Monitor${C.reset}  ${C.dim}refreshing every ${interval}s · updated ${updatedAt.toLocaleTimeString()} · Ctrl+C to exit${C.reset}`,
  );

  if (errorMsg) {
    lines.push(`\n ${C.red}⚠  ${errorMsg}${C.reset}`);
  }

  lines.push('');

  // Group containers by project
  const byProject = new Map<string, ContainerRow[]>();
  for (const row of containerRows) {
    if (! byProject.has(row.project)) byProject.set(row.project, []);
    byProject.get(row.project)!.push(row);
  }

  if (byProject.size === 0) {
    lines.push(`  ${C.dim}No running containers${C.reset}`);
  } else {
    for (const [project, rows] of [...byProject.entries()].sort()) {
      lines.push(`${C.bold}${C.blue} ▸ ${project}${C.reset}`);

      const t = new Table({
        head: ['ID', 'NAME', 'HEALTH', 'UPTIME', 'CPU', 'MEMORY', 'RESTARTS', 'LAST LOG'],
        colWidths: [14, 32, 16, 10, 9, 28, 10, 12],
        style: { head: ['cyan'], border: ['gray'], compact: true },
        chars: { mid: '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' },
      });

      for (const row of rows.sort((a, b) => a.name.localeCompare(b.name))) {
        const statusDot =
          row.status === 'running' ? `${C.green}●${C.reset}` : `${C.red}●${C.reset}`;
        const restartsStr =
          parseInt(row.restarts) > 0
            ? `${C.yellow}${row.restarts}${C.reset}`
            : `${C.dim}${row.restarts}${C.reset}`;

        t.push([
          `${C.dim}${row.id}${C.reset}`,
          `${statusDot} ${row.name}`,
          row.health,
          row.uptime,
          colorCpu(row.cpu),
          row.mem,
          restartsStr,
          colorLastLog(row.lastLog, row.name),
        ]);
      }

      lines.push(t.toString());
      lines.push('');
    }
  }

  // RabbitMQ section
  if (queuesByInstance.size === 0 && rabbitErrors.size === 0) {
    lines.push(`${C.bold}${C.blue} ▸ RabbitMQ${C.reset}`);
    lines.push(`  ${C.dim}No RabbitMQ containers discovered${C.reset}`);
  }

  for (const [instanceName, rows] of [...queuesByInstance.entries()].sort()) {
    lines.push(`${C.bold}${C.blue} ▸ RabbitMQ · ${instanceName}${C.reset}`);

    if (rows.length === 0) {
      lines.push(`  ${C.dim}No queues${C.reset}`);
    } else {
      const qt = new Table({
        head: ['QUEUE', 'VHOST', 'READY', 'UNACKED', 'TOTAL', 'CONSUMERS', 'PUBLISH/s', 'DELIVER/s', 'STATE'],
        colWidths: [28, 12, 10, 10, 10, 11, 11, 11, 10],
        style: { head: ['cyan'], border: ['gray'], compact: true },
        chars: { mid: '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' },
      });

      for (const q of rows.sort((a, b) => a.name.localeCompare(b.name))) {
        qt.push([
          q.name,
          `${C.dim}${q.vhost}${C.reset}`,
          q.ready > 0 ? `${C.yellow}${q.ready}${C.reset}` : `${C.dim}${q.ready}${C.reset}`,
          colorUnacked(q.unacked),
          q.total > 0 ? String(q.total) : `${C.dim}0${C.reset}`,
          String(q.consumers),
          q.publishRate,
          q.deliverRate,
          q.state === 'running' ? `${C.green}${q.state}${C.reset}` : `${C.yellow}${q.state}${C.reset}`,
        ]);
      }

      lines.push(qt.toString());
    }
    lines.push('');
  }

  for (const [instanceName, err] of rabbitErrors.entries()) {
    lines.push(`${C.bold}${C.blue} ▸ RabbitMQ · ${instanceName}${C.reset}`);
    lines.push(`  ${C.red}⚠ ${err}${C.reset}`);
    lines.push('');
  }

  return lines.join('\n');
}
