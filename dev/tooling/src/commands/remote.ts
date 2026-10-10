import { Command } from 'commander';
import { run } from '../tools/remote/index';
import { error } from '../shared/ui/logger';

function handleError(err: unknown): never {
  error((err as Error).message);
  process.exit(1);
}

export function register(program: Command): void {
  const remote = program
    .command('remote')
    .description('Remote server operations')
    .action(async () => {
      try {
        await run();
      } catch (err) {
        handleError(err);
      }
    });

  remote
    .command('sync-env')
    .description('SCP all .env files to a remote server')
    .action(async () => {
      try {
        await run();
      } catch (err) {
        handleError(err);
      }
    });
}
