import { Command } from 'commander';
import { run as runBouncerTool, add as addAccount } from '../tools/bouncer/index';
import { error } from '../shared/ui/logger';

export function register(program: Command): void {
  const bouncer = program
    .command('bouncer')
    .description('View accounts and tokens from Bouncer service')
    .option('-a, --all', 'Show all details')
    .option('--account <name>', 'Show details for specific account')
    .action(async (options: any) => {
      try {
        await runBouncerTool(options);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  bouncer
    .command('add <id>')
    .description('Register a new account with Bouncer')
    .action(async (id: string) => {
      try {
        await addAccount(id);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}
