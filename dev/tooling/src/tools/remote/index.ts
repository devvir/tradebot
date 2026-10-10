import { run as runSyncEnv } from './sync-env';

/** `sync-env` is the one remote operation there is, so `remote` alone runs it. */
export async function run(): Promise<void> {
  await runSyncEnv();
}
