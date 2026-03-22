import { Command } from 'commander';
import { run as runRabbitTool } from '../tools/rabbitmq/index.js';
import { error } from '../shared/ui/logger.js';

export function register(program: Command): void {
  program
    .command('rabbit [queue]')
    .alias('amqp')
    .description('Monitor RabbitMQ queues and streams')
    .option('-l, --list', 'List all queues')
    .option('-w, --watch', 'Watch queue in real-time')
    .option('--messages <count>', 'Number of messages to fetch', '10')
    .action(async (queueArg: string | undefined, options: any) => {
      try {
        await runRabbitTool(queueArg, options);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}
