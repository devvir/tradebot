import { logger, RabbitMQ } from '@devvir/service-kit';
import type { Route, RouteDestination, RoutingKeyConfig, Config } from './types';
import { formatRoute } from './routes';

/** How long a failed message waits before it is requeued, while the publisher is connected. */
export const REQUEUE_DELAY_MS = 500;

/** The shortest gap between two 'Failed to route message' logs of one source queue. */
export const FAILURE_LOG_INTERVAL_MS = 10_000;

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * For each source queue, consume messages and republish them to every distinct destination of
 * the rules on that queue: rules that share a queue and name the same destination publish once.
 *
 * The consumer channel holds at most `config.prefetch` unacknowledged messages per source queue.
 * Every publish goes through the publisher broker; a named exchange is looked up on it for each
 * message, and a bare queue is published to through the default exchange on its channel.
 *
 * A message is acked once every destination has it, and requeued when any publish fails, so a
 * retry publishes again to the destinations that already had it: delivery is at least once per
 * destination. A failed message is requeued once the publisher is connected again, or after
 * REQUEUE_DELAY_MS when it is connected. An ack or nack on a closed channel is logged and
 * dropped, since the broker redelivers the message. A consumer the broker cancels ends the
 * process with exit code 1.
 */
export const consumeAndRepublish = async (
  consumer: RabbitMQ.Broker,
  publisher: RabbitMQ.Broker,
  config: Config,
  holdPublishing: (() => Promise<void>) | null,
): Promise<void> => {
  const channel = consumer.getChannel();

  if (! channel)
    throw new Error('No RabbitMQ channel available');

  await channel.prefetch(config.prefetch);

  const publish         = publisherOf(publisher);
  const publisherOnline = whenConnected(publisher);

  for (const [queueName, routes] of groupBySource(config.routes)) {
    const targets    = distinctDestinations(routes).map(toTarget);
    const logFailure = throttledFailureLog(queueName);

    await channel.consume(queueName, async (msg) => {
      if (! msg) {
        logger.error({ source: queueName }, 'The broker cancelled the consumer; exiting');
        process.exit(1);
        return;
      }

      try {
        if (holdPublishing) await holdPublishing();

        const incomingKey = msg.fields?.routingKey || '';

        for (const target of targets) {
          await publish(target, msg, {
            routingKey: target.fixedRoutingKey ?? resolveRoutingKey(target.routingKey, incomingKey),
            persistent: msg.properties?.deliveryMode === 2,
            userId:     undefined,
            // An injected header replaces an incoming header of the same name.
            ...(target.headers ? { headers: { ...(msg.properties?.headers ?? {}), ...target.headers } } : {}),
          });
        }

        settle(queueName, 'ack', () => channel.ack(msg));
      } catch (err) {
        logFailure(err);

        if (publisher.getState() === 'connected') await delay(REQUEUE_DELAY_MS);
        else await publisherOnline();

        settle(queueName, 'nack', () => channel.nack(msg, false, true));
      }
    });

    logger.info({
      source: queueName,
      routes: routes.map(formatRoute),
    }, 'Route established');
  }
};

// ── Private ───────────────────────────────────────────────────────────────────

/**
 * Where a destination publishes: a named exchange, or the default exchange with the bare
 * queue's name as fixed routing key.
 */
interface Target {
  exchange: string | undefined;
  routingKey: RoutingKeyConfig | undefined;
  fixedRoutingKey: string | undefined;
  headers: Record<string, string> | undefined;
}

type Publish = (target: Target, msg: RabbitMQ.RawMessage, overrides: RabbitMQ.RepublishOptions) => Promise<void>;

/**
 * Republish through the publisher broker. A named exchange is looked up on each call, so a
 * publish always uses the instance the broker currently holds. The default exchange is one
 * instance on the publisher's channel, which follows the publisher across reconnections.
 */
const publisherOf = (publisher: RabbitMQ.Broker): Publish => {
  const publisherChannel = publisher.getChannel();

  if (! publisherChannel)
    throw new Error('No RabbitMQ publisher channel available');

  const defaultExchange = new RabbitMQ.Exchange(publisherChannel, '');

  publisher.on('connect',    () => defaultExchange.setChannel(publisher.getChannel()));
  publisher.on('disconnect', () => defaultExchange.setChannel(null));

  return (target, msg, overrides) => {
    if (target.exchange === undefined) return defaultExchange.republish(msg, overrides);

    const exchange = publisher.getExchange(target.exchange);

    if (! exchange) throw new Error(`Destination exchange not found: ${target.exchange}`);

    return exchange.republish(msg, overrides);
  };
};

/**
 * A promise that resolves once the broker is connected. Callers that wait at the same time
 * share one listener.
 */
const whenConnected = (broker: RabbitMQ.Broker): (() => Promise<void>) => {
  let pending: Promise<void> | null = null;

  return () => {
    if (broker.getState() === 'connected') return Promise.resolve();

    return (pending ??= new Promise<void>((resolve) => {
      broker.once('connect', () => {
        pending = null;
        resolve();
      });
    }));
  };
};

/** Ack or nack a message; a failure (a closed channel) is logged, as the broker redelivers it. */
const settle = (source: string, action: 'ack' | 'nack', fn: () => void): void => {
  try {
    fn();
  } catch (err) {
    logger.warn({ err, source }, `Could not ${action} the message; the broker redelivers it`);
  }
};

/**
 * Log routing failures of one source queue at most once per FAILURE_LOG_INTERVAL_MS, with the
 * number of failures left unlogged since the previous log.
 */
const throttledFailureLog = (source: string): ((err: unknown) => void) => {
  let loggedAt   = -Infinity;
  let suppressed = 0;

  return (err) => {
    const now = Date.now();

    if (now - loggedAt < FAILURE_LOG_INTERVAL_MS) {
      suppressed++;
      return;
    }

    logger.error({ err, source, ...(suppressed ? { suppressed } : {}) }, 'Failed to route message');
    loggedAt   = now;
    suppressed = 0;
  };
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const groupBySource = (routes: Route[]): Map<string, Route[]> => {
  const grouped = new Map<string, Route[]>();

  for (const route of routes) {
    const key = route.source.queue;

    if (! grouped.has(key)) grouped.set(key, []);

    grouped.get(key)!.push(route);
  }

  return grouped;
};

const toTarget = (dest: RouteDestination): Target => dest.exchange
  ? { exchange: dest.exchange.name, routingKey: dest.routingKey, fixedRoutingKey: undefined, headers: dest.headers }
  : { exchange: undefined, routingKey: undefined, fixedRoutingKey: dest.queue!, headers: dest.headers };

/**
 * The destinations of the routes, once each: two destinations are the same when they publish to
 * the same exchange (or bare queue) with the same key setting and headers.
 */
const distinctDestinations = (routes: Route[]): RouteDestination[] => {
  const byKey = new Map<string, RouteDestination>();

  for (const { destination: d } of routes) {
    const key = JSON.stringify([
      d.exchange ? `@${d.exchange.name}` : d.queue,
      d.routingKey ?? null,
      Object.entries(d.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ]);

    if (! byKey.has(key)) byKey.set(key, d);
  }

  return [...byKey.values()];
};

/**
 * The routing key of a republish. Without a key setting it is the incoming key; with
 * `value:replace`, an incoming key equal to `value` or starting with `value.` has that leading
 * part replaced by `replace`, taken literally, and any other key passes unchanged; with a plain
 * `value`, it is that value.
 */
const resolveRoutingKey = (config: RoutingKeyConfig | undefined, incoming: string): string => {
  if (! config) return incoming;

  if (config.replace !== undefined) {
    const { value, replace } = config;

    return incoming === value || incoming.startsWith(`${value}.`)
      ? replace + incoming.slice(value.length)
      : incoming;
  }

  return config.value;
};
