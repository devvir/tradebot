import { spawnSync } from 'node:child_process';

/**
 * Why a docker daemon cannot be reached from here, or nothing when it can.
 * `docker info` fails both when the CLI is missing and when the daemon is down.
 */
const whyNoDocker = (): string | undefined => {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 10000 });

  if (result.error) return `docker cannot be run (${result.error.message})`;
  if (result.status !== 0) return 'docker info failed, so no daemon is reachable';

  return undefined;
};

export const dockerUnavailable = whyNoDocker();
