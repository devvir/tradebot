import Dockerode from 'dockerode';
import { terminalSafe } from '../../shared/utils/terminal';
import { fetchContainerRows } from './docker';
import { discoverRabbitInstances, fetchQueueRows } from './rabbitmq';
import { buildOutput } from './render';
import type { ContainerRow, QueueRow, RabbitInstance } from './types';

/** The shortest refresh interval, in seconds. */
export const MIN_INTERVAL_SECONDS = 0.5;

/**
 * The refresh interval in seconds, from a number or its text form ("3", "0.5"). A value that is not a finite
 * number, or is below {@link MIN_INTERVAL_SECONDS}, is refused.
 */
export function parseInterval(raw: number | string | undefined, fallback = 3): number {
  if (raw === undefined) return fallback;

  const seconds = typeof raw === 'number' ? raw : Number(raw.trim());

  if (! Number.isFinite(seconds) || seconds < MIN_INTERVAL_SECONDS) {
    throw new Error(`Invalid interval "${raw}": expected a number of seconds, at least ${MIN_INTERVAL_SECONDS}`);
  }

  return seconds;
}

/**
 * Runs `tick` now and then again `intervalMs` after each run finishes, so two runs never overlap. A run that
 * throws is passed to `onError` and the loop carries on. Returns a function that stops the loop.
 */
export function startLoop(tick: () => Promise<void>, intervalMs: number, onError: (err: unknown) => void): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const loop = async () => {
    try {
      await tick();
    } catch (err) {
      onError(err);
    }

    if (! stopped) timer = setTimeout(loop, intervalMs);
  };

  void loop();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export async function run(options: { interval?: number | string } = {}): Promise<void> {
  const interval = parseInterval(options.interval);
  const docker = new Dockerode();

  process.stdout.write('\x1b[?25l');
  let firstRun = true;

  const restore = () => {
    process.stdout.write('\x1b[?25h\n');
    process.exit(0);
  };

  process.on('SIGINT', restore);
  process.on('SIGTERM', restore);

  const tick = async () => {
    let containerRows: ContainerRow[] = [];
    const queuesByInstance = new Map<string, QueueRow[]>();
    const rabbitErrors = new Map<string, string>();
    let errorMsg: string | null = null;

    const instancesByName = new Map<string, RabbitInstance>();

    try {
      containerRows = await fetchContainerRows(docker);
      const instances = await discoverRabbitInstances(docker);

      for (const inst of instances) {
        instancesByName.set(inst.name, inst);
      }

      await Promise.all(
        instances.map(async (inst) => {
          try {
            queuesByInstance.set(inst.name, await fetchQueueRows(inst));
          } catch (err) {
            rabbitErrors.set(inst.name, (err as Error).message);
          }
        }),
      );
    } catch (err) {
      errorMsg = (err as Error).message;
    }

    const output = buildOutput(containerRows, queuesByInstance, rabbitErrors, instancesByName, interval, new Date(), errorMsg);

    process.stdout.write(firstRun ? '\x1b[2J\x1b[H' : '\x1b[H\x1b[J');
    firstRun = false;
    process.stdout.write(output);
  };

  startLoop(tick, interval * 1000, (err) => {
    process.stdout.write(`\n \x1b[31m⚠  Refresh failed: ${terminalSafe((err as Error)?.message ?? String(err))}\x1b[0m\n`);
  });
}
