import { Command } from 'commander';
import { run as runSignalTool } from '../tools/signal/index.js';
import { error } from '../shared/ui/logger.js';

export function register(program: Command): void {
  program
    .command('signal')
    .description('View signals and indicators from Signal service')
    .option('-l, --latest', 'Show latest signals only')
    .option('--symbol <symbol>', 'Filter by symbol')
    .action(async (options: any) => {
      try {
        await runSignalTool(options);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}
