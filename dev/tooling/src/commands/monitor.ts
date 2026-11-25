import { Command } from 'commander';
import { run as runMonitorTool, MIN_INTERVAL_SECONDS } from '../tools/monitor/index';
import { error } from '../shared/ui/logger';

export function register(program: Command): void {
  program
    .command('monitor')
    .alias('mon')
    .description('Live dashboard: Docker container stats and RabbitMQ queue health')
    .option('-i, --interval <seconds>', `Refresh interval in seconds (at least ${MIN_INTERVAL_SECONDS})`, '3')
    .action(async (options: any) => {
      try {
        await runMonitorTool({ interval: options.interval });
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}
