import Dockerode from 'dockerode';
import { fetchContainerRows } from './docker';
import { discoverRabbitInstances, fetchQueueRows } from './rabbitmq';
import { buildOutput } from './render';
import type { ContainerRow, QueueRow } from './types';

export async function run(options: { interval?: number } = {}): Promise<void> {
  const interval = options.interval ?? 3;
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

    try {
      containerRows = await fetchContainerRows(docker);
      const instances = await discoverRabbitInstances(docker);

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

    const output = buildOutput(containerRows, queuesByInstance, rabbitErrors, interval, new Date(), errorMsg);

    process.stdout.write(firstRun ? '\x1b[2J\x1b[H' : '\x1b[H\x1b[J');
    firstRun = false;
    process.stdout.write(output);
  };

  await tick();
  setInterval(tick, interval * 1000);
}
