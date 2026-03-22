import { connectRabbit } from '../../shared/connections/rabbitmq';
import { info, success, error, section, table, spacer, warn } from '../../shared/ui/logger';

interface RabbitOptions {
  list?: boolean;
  watch?: boolean;
  messages?: string;
}

export async function run(queueArg?: string, options: RabbitOptions = {}): Promise<void> {
  section('RabbitMQ Monitoring Tool');
  spacer();

  const { connection, channel, mgmtUrl, mgmtAuth } = await connectRabbit();

  try {
    spacer();

    if (options.list) {
      section('Available Queues');

      try {
        const response = await fetch(`${mgmtUrl}/queues`, {
          headers: { Authorization: `Basic ${mgmtAuth}` },
        });

        if (response.ok) {
          const queues = (await response.json()) as any[];

          table(
            queues.map((q: any) => ({
              Name: q.name,
              Messages: q.messages || 0,
              Ready: q.messages_ready || 0,
              Consumers: q.consumers || 0,
            })),
            ['Name', 'Messages', 'Ready', 'Consumers'],
          );
        } else {
          warn('Could not fetch queue list from management API');
        }
      } catch (err) {
        warn(`Could not connect to RabbitMQ management API: ${(err as Error).message}`);
      }

      await channel.close();
      await connection.close();
      return;
    }

    if (! queueArg) {
      warn('Specify a queue name or use --list to see available queues');
      await channel.close();
      await connection.close();
      return;
    }

    const queueInfo = await channel.checkQueue(queueArg);

    section(`Queue: ${queueArg}`);
    console.log(`Messages: ${queueInfo.messageCount}`);
    console.log(`Consumers: ${queueInfo.consumerCount}`);
    spacer();

    if (options.watch) {
      info(`Watching ${queueArg} for new messages...`);
      info('Press Ctrl+C to stop');
      spacer();

      let messageCount = 0;

      await channel.prefetch(1);
      channel.consume(
        queueArg,
        (msg: any) => {
          if (! msg) return;

          messageCount++;
          const content = msg.content.toString();

          section(`Message #${messageCount} [${new Date().toISOString()}]`);

          try {
            console.log(JSON.stringify(JSON.parse(content), null, 2));
          } catch {
            console.log(content);
          }

          channel.nack(msg, false, true);
        },
        { noAck: false },
      );

      process.on('SIGINT', async () => {
        info('Stopping watch...');
        await channel.close();
        await connection.close();
        success('Disconnected');
        process.exit(0);
      });
    } else {
      const count = parseInt(options.messages || '10') || 10;

      section(`Fetching up to ${count} messages from ${queueArg}...`);

      const messages: any[] = [];

      for (let i = 0; i < count; i++) {
        const msg = await channel.get(queueArg, { noAck: true });
        if (! msg) break;

        try {
          messages.push(JSON.parse(msg.content.toString()));
        } catch {
          messages.push({ raw: msg.content.toString() });
        }
      }

      if (messages.length === 0) {
        info('Queue is empty');
      } else {
        spacer();
        messages.forEach((msg, idx) => {
          section(`Message ${idx + 1}`);
          console.log(JSON.stringify(msg, null, 2));
        });
      }

      spacer();
      await channel.close();
      await connection.close();
    }
  } catch (err) {
    error(`Connection failed: ${(err as Error).message}`);
    throw err;
  }
}
