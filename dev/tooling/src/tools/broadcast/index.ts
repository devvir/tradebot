import { connectRabbit } from '../../shared/connections/rabbitmq';
import { info, success, error, section, spacer } from '../../shared/ui/logger';

interface BroadcastOptions {
  type?: string;
}

export async function run(options: BroadcastOptions = {}): Promise<void> {
  section('Broadcast Monitoring Tool');
  spacer();

  const { connection, channel } = await connectRabbit();

  try {
    spacer();

    await channel.assertExchange('broadcast', 'fanout', { durable: true });
    const queue = await channel.assertQueue('', { exclusive: true });
    await channel.bindQueue(queue.queue, 'broadcast', '');

    info(options.type ? `Monitoring broadcast messages (type: ${options.type})...` : 'Monitoring broadcast messages...');
    info('Press Ctrl+C to stop');
    spacer();

    let messageCount = 0;

    channel.consume(queue.queue, (msg: any) => {
      if (! msg) return;

      const content = msg.content.toString();

      try {
        const json = JSON.parse(content);
        const msgType = json.type || json.action;

        if (options.type && msgType !== options.type) {
          channel.ack(msg);
          return;
        }

        messageCount++;
        section(`Message #${messageCount} [${new Date().toISOString()}]`);

        if (msgType) console.log(`Type: ${msgType}`);
        console.log(JSON.stringify(json, null, 2));
      } catch {
        messageCount++;
        section(`Message #${messageCount} [${new Date().toISOString()}]`);
        console.log(content);
      }

      channel.ack(msg);
    });

    process.on('SIGINT', async () => {
      info('Stopping broadcast monitor...');
      await channel.close();
      await connection.close();
      success('Disconnected');
      process.exit(0);
    });
  } catch (err) {
    error(`Failed to monitor broadcast: ${(err as Error).message}`);
    try { await connection.close(); } catch {}
    throw err;
  }
}
