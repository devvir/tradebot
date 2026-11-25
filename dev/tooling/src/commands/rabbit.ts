import { Command } from 'commander';
import { run as runRabbitTool } from '../tools/rabbitmq/index';
import { error } from '../shared/ui/logger';

export const DESCRIPTION = 'Inspect RabbitMQ queues: show the oldest messages (requeued, marked redelivered) or watch new ones';

export function register(program: Command): void {
  program
    .command('rabbit [queue]')
    .alias('amqp')
    .description(DESCRIPTION)
    .option('-l, --list', 'List all queues')
    .option('-w, --watch', 'Print messages as they are published to the queue\'s exchanges, without reading the queue')
    .option(
      '--messages <count>',
      'Fetch: how many messages to show from the head of the queue (default 10), all requeued and marked '
        + 'redelivered. Watch: stop after this many',
    )
    .option('--url <amqp-url>', 'Connect to this AMQP URL instead of a discovered container')
    .action(async (queueArg: string | undefined, options: any) => {
      try {
        await runRabbitTool(queueArg, options);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}
