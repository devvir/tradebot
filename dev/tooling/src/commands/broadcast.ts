import { Command } from 'commander';
import { run as runBroadcastTool } from '../tools/broadcast/index.js';
import { error } from '../shared/ui/logger.js';

export function register(program: Command): void {
  program
    .command('broadcast')
    .description('Monitor broadcast exchange messages in real-time')
    .option('--type <type>', 'Filter by message type')
    .action(async (options: any) => {
      try {
        await runBroadcastTool(options);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}
