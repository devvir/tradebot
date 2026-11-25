import type { ConsumeMessage, GetMessage } from 'amqplib';
import { connectRabbit, type RabbitConnection } from '../../shared/connections/rabbitmq';
import { info, success, section, table, spacer, warn } from '../../shared/ui/logger';
import { terminalSafe } from '../../shared/utils/terminal';

interface RabbitOptions {
  list?: boolean;
  watch?: boolean;
  messages?: string;
  url?: string;
}

const DEFAULT_FETCH_COUNT = 10;

/** How many unacknowledged stream messages the broker sends ahead of the watcher. */
const STREAM_PREFETCH = 100;

/** A binding as the management API lists it for a queue. */
interface Binding {
  source: string;
  routing_key: string;
  arguments?: Record<string, unknown>;
}

/**
 * Inspect a queue without taking anything from it.
 *
 * - `--list` lists the broker's queues through the management API.
 * - Fetch (the default) reads up to `--messages` (10) messages from the head of the queue — its
 *   oldest — and hands them all back with `nackAll(true)`, so the queue keeps them, marked
 *   redelivered. Stream queues cannot be read this way and are refused.
 * - `--watch` prints messages as they are published, until Ctrl+C or until `--messages` have been
 *   printed. For a classic or quorum queue it binds a private, auto-deleted queue to the same
 *   exchanges with the same keys and reads that, so the queue itself and its consumers are never
 *   touched; messages published straight to the queue through the default exchange are not seen.
 *   A stream queue is read from its next offset, which leaves the stream as it is.
 *
 * What the broker supplies — message bodies, queue and exchange names, routing keys — is printed
 * with its control characters escaped, so it cannot drive the terminal.
 *
 * Errors, including a queue list that cannot be fetched, are thrown, not printed; a watched queue
 * bound to no exchange is a warning, not an error. The connection is closed whatever happens.
 */
export async function run(queueArg?: string, options: RabbitOptions = {}): Promise<void> {
  section('RabbitMQ Monitoring Tool');
  spacer();

  const rabbit = await connectRabbit({ url: options.url });
  const disconnect = disconnector(rabbit);

  try {
    spacer();

    if (options.list) {
      await listQueues(rabbit);
      return;
    }

    if (! queueArg) {
      warn('Specify a queue name or use --list to see available queues');
      return;
    }

    const queueInfo = await checkQueue(rabbit, queueArg);

    section(`Queue: ${queueArg}`);
    console.log(`Messages: ${queueInfo.messageCount}`);
    console.log(`Consumers: ${queueInfo.consumerCount}`);
    spacer();

    if (options.watch) {
      const limit = options.messages === undefined ? null : parseCount(options.messages);

      await watch(rabbit, queueArg, limit, disconnect);
    } else {
      await fetchHead(rabbit, queueArg, parseCount(options.messages ?? String(DEFAULT_FETCH_COUNT)));
      spacer();
    }
  } finally {
    await disconnect();
  }
}

async function listQueues(rabbit: RabbitConnection): Promise<void> {
  section('Available Queues');

  if (! rabbit.mgmtUrl) {
    throw new Error(`Cannot list queues without the management API: ${rabbit.mgmtUnavailable}`);
  }

  let queues: any[];

  try {
    queues = await mgmtGet(rabbit, '/queues');
  } catch (err) {
    throw new Error(`Could not fetch the queue list from the management API: ${(err as Error).message}`);
  }

  table(
    queues.map((q: any) => ({
      Name: terminalSafe(String(q.name)),
      Messages: q.messages || 0,
      Ready: q.messages_ready || 0,
      Consumers: q.consumers || 0,
    })),
    ['Name', 'Messages', 'Ready', 'Consumers'],
  );
}

async function checkQueue(rabbit: RabbitConnection, queue: string) {
  try {
    return await rabbit.channel.checkQueue(queue);
  } catch (err) {
    if ((err as { code?: number }).code === 404) {
      throw new Error(`Queue '${queue}' not found - run with --list`);
    }

    throw err;
  }
}

/** Print up to `count` messages from the head of the queue, then requeue every one of them. */
async function fetchHead(rabbit: RabbitConnection, queue: string, count: number): Promise<void> {
  const { channel } = rabbit;

  if (await queueType(rabbit, queue) === 'stream') {
    throw new Error(`Queue '${queue}' is a stream, which cannot be fetched from - use --watch`);
  }

  section(`Fetching up to ${count} messages from the head of ${queue} (requeued afterwards)...`);

  const held: GetMessage[] = [];

  try {
    for (let i = 0; i < count; i++) {
      const msg = await channel.get(queue, { noAck: false });
      if (! msg) break;
      held.push(msg);
    }

    if (held.length === 0) {
      info('Queue is empty');
      return;
    }

    spacer();
    held.forEach((msg, idx) => {
      section(`Message ${idx + 1}`);
      printContent(msg.content);
    });
  } finally {
    if (held.length > 0) {
      try {
        channel.nackAll(true);
      } catch {
        // The channel is gone; the broker requeues the messages it had delivered on it.
      }
    }
  }
}

/** Resolves once the watch has stopped and the connection is closed. */
async function watch(
  rabbit: RabbitConnection,
  queue: string,
  limit: number | null,
  disconnect: () => Promise<void>,
): Promise<void> {
  const { channel } = rabbit;

  if (! rabbit.mgmtUrl) {
    throw new Error(`Cannot watch without the management API: ${rabbit.mgmtUnavailable}`);
  }

  const vhost = encodeURIComponent(vhostOf(rabbit.url));
  const details = await mgmtGet(rabbit, `/queues/${vhost}/${encodeURIComponent(queue)}`);
  const isStream = details?.type === 'stream';

  let source: string;
  let bindings: Binding[] = [];

  if (isStream) {
    source = queue;
  } else {
    const all: Binding[] = await mgmtGet(rabbit, `/queues/${vhost}/${encodeURIComponent(queue)}/bindings`);
    bindings = all.filter(b => b.source !== '');

    if (bindings.length === 0) {
      warn(`Queue '${queue}' is bound to no exchange but the default one, so there is nothing to watch: `
        + 'watch shows what is published to the exchanges a queue is bound to');
      return;
    }

    const tap = await channel.assertQueue('', { exclusive: true, autoDelete: true });

    for (const b of bindings) {
      await channel.bindQueue(tap.queue, b.source, b.routing_key, b.arguments);
    }

    source = tap.queue;
  }

  info(isStream
    ? `Watching stream ${queue} from its next offset...`
    : `Watching what is published to ${queue} through ${bindings.map(b => `${terminalSafe(b.source)} (${terminalSafe(b.routing_key) || '*'})`).join(', ')}...`);
  info(limit === null ? 'Press Ctrl+C to stop' : `Stopping after ${limit} messages, or on Ctrl+C`);
  spacer();

  await new Promise<void>((resolve, reject) => {
    let seen = 0;
    let stopping = false;

    const stop = async (): Promise<boolean> => {
      if (stopping) return false;
      stopping = true;
      info('Stopping watch...');
      await disconnect();
      success('Disconnected');
      resolve();
      return true;
    };

    const onSignal = async () => {
      if (await stop()) process.exit(0);
    };

    const stopQuietly = () => {
      void stop().then(() => {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      });
    };

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    const onMessage = (msg: ConsumeMessage | null) => {
      if (! msg) {
        warn('The broker cancelled the watch');
        stopQuietly();
        return;
      }

      if (stopping) return;

      seen++;

      const route = msg.fields?.exchange
        ? ` ${terminalSafe(msg.fields.exchange)} ${terminalSafe(String(msg.fields.routingKey ?? ''))}`
        : '';
      section(`Message #${seen} [${new Date().toISOString()}]${route}`);
      printContent(msg.content);

      if (isStream) channel.ack(msg);

      if (limit !== null && seen >= limit) stopQuietly();
    };

    const consuming = isStream
      ? channel.prefetch(STREAM_PREFETCH).then(() => channel.consume(source, onMessage, {
        noAck: false,
        arguments: { 'x-stream-offset': 'next' },
      }))
      : channel.consume(source, onMessage, { noAck: true });

    consuming.catch(err => {
      stopping = true;
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      reject(err);
    });
  });
}

/** A message body, pretty-printed when it is JSON, with its control characters escaped. */
function printContent(content: Buffer): void {
  const text = content.toString();
  let shown: string;

  try {
    shown = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    shown = text;
  }

  console.log(terminalSafe(shown, { multiline: true }));
}

/** The queue's type from the management API, or undefined when that cannot be read. */
async function queueType(rabbit: RabbitConnection, queue: string): Promise<string | undefined> {
  if (! rabbit.mgmtUrl) return undefined;

  try {
    const vhost = encodeURIComponent(vhostOf(rabbit.url));
    const details = await mgmtGet(rabbit, `/queues/${vhost}/${encodeURIComponent(queue)}`);

    return details?.type;
  } catch {
    return undefined;
  }
}

async function mgmtGet(rabbit: RabbitConnection, path: string): Promise<any> {
  let response: Response;

  try {
    response = await fetch(`${rabbit.mgmtUrl}${path}`, {
      headers: { Authorization: `Basic ${rabbit.mgmtAuth}` },
    });
  } catch (err) {
    throw new Error(`Could not reach the management API: ${(err as Error).message}`);
  }

  if (! response.ok) {
    throw new Error(`The management API answered ${response.status} for ${path}`);
  }

  return response.json();
}

/** The virtual host an AMQP URL names: its path without the leading slash, `/` when empty. */
function vhostOf(url: string): string {
  try {
    const path = new URL(url).pathname;

    return path.length > 1 ? decodeURIComponent(path.slice(1)) : '/';
  } catch {
    return '/';
  }
}

function parseCount(raw: string): number {
  const count = Number(raw);

  if (! Number.isInteger(count) || count < 1) {
    throw new Error(`--messages must be a positive whole number, not '${raw}'`);
  }

  return count;
}

/** Closes the channel and then the connection once, however many times it is called, never throwing. */
function disconnector(rabbit: RabbitConnection): () => Promise<void> {
  let closing: Promise<void> | null = null;

  return () => {
    closing ??= (async () => {
      await Promise.resolve().then(() => rabbit.channel.close()).catch(() => {});
      await Promise.resolve().then(() => rabbit.connection.close()).catch(() => {});
    })();

    return closing;
  };
}
