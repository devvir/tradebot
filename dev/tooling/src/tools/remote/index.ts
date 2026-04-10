import { selectTool } from '../../shared/ui/prompts.js';
import { run as runSyncEnv } from './sync-env.js';
import { run as runPull } from './pull.js';

type SubCommand = 'sync-env' | 'pull';

const subcommands = [
  { id: 'sync-env', name: 'Sync Env', description: 'SCP all .env files to a remote server' },
  { id: 'pull', name: 'Pull', description: 'Pull vault files from remote (skips unchanged files)' },
];

export async function run(subcommand: SubCommand | null, source?: string): Promise<void> {
  const cmd = subcommand ?? (await selectTool(subcommands) as SubCommand);

  if (cmd === 'sync-env') {
    await runSyncEnv();
  } else if (cmd === 'pull') {
    await runPull(source);
  }
}
