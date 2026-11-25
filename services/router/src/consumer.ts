import { logger, RabbitMQ } from '@devvir/service-kit';
import { backoffDelay } from '@tradebot/utils';
import type { Route, RouteDestination, RoutingKeyConfig, Config } from './types';
import type { BackpressureGate } from './backpressure';
import { formatRoute } from './routes';

/** The back-off before the first retry of a failed message; each further failure doubles it. */
export const RETRY_BASE_DELAY_MS = 500;

/** The longest back-off before a retry. */
export const RETRY_MAX_DELAY_MS = 30_000;

/** The shortest gap between two 'Failed to route message' logs of one source queue. */
export const FAILURE_LOG_INTERVAL_MS = 10_000;

/** How many times routing a message has failed, on the copy the router retries or dead-letters. */
export const ATTEMPTS_HEADER = 'x-router-attempts';

/** The routing key a message arrived with, on the copy the router retries or dead-letters. */
export const ROUTING_KEY_HEADER = 'x-router-routing-key';

/** The source queue a dead-lettered message was read from. */
export const SOURCE_QUEUE_HEADER = 'x-router-source-queue';

/** The error of the last failed attempt at a dead-lettered message. */
export const ERROR_HEADER = 'x-router-error';

/** The router's own headers: a destination never receives them. */
const ROUTER_HEADERS = [ATTEMPTS_HEADER, ROUTING_KEY_HEADER, SOURCE_QUEUE_HEADER, ERROR_HEADER];

/** What the consumer needs of the backpressure gate. */
export type Backpressure = Pick<BackpressureGate, 'atCapacity' | 'hold'>;

/** The running consumers of the source queues. */
export interface Routing {
  /**
   * Cancel every source consumer for good: a pause for backpressure that is under way does not
   * consume again. Rejects when a consumer cannot be cancelled.
   */
  stop: () => Promise<void>;
  /**
   * Resolves once no delivery is being handled, a delivery being handled until it is acked or
   * nacked. Deliveries that arrive while it waits are waited for too.
   */
  settled: () => Promise<void>;
}

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * For each source queue, consume messages and republish them to every distinct destination of
 * the rules on that queue: rules that share a queue and name the same destination publish once.
 *
 * The consumer channel holds at most `config.prefetch` unacknowledged messages per source queue.
 * Every publish goes through the publisher broker; a named exchange is looked up on it for each
 * message, and a bare queue is published to through the default exchange on its channel. The
 * message body and properties are republished as they arrived, apart from the routing key, the
 * user id, which is dropped, the destination's injected headers, and the router's own headers
 * (ATTEMPTS_HEADER and the others), which are removed.
 *
 * Backpressure: when a message arrives while the gate is at capacity, every source consumer is
 * cancelled, so the broker keeps the messages behind it, and is consumed again once the gate
 * has room. The messages delivered before the cancel are routed as usual, so `config.maxReady`
 * is a soft limit: a watched queue can pass it by up to `config.prefetch` messages per source
 * queue, plus what arrives between two depth reads.
 *
 * A message is acked once its publish to every destination has returned. When a publish fails
 * while the publisher is connected, the attempt counts: after a back-off of RETRY_BASE_DELAY_MS,
 * doubled with each further failure up to RETRY_MAX_DELAY_MS, a copy of the message is published
 * to the back of its source queue with the failed attempts in ATTEMPTS_HEADER and its routing key
 * in ROUTING_KEY_HEADER, and the original is acked. A retry publishes again to the destinations
 * that already had it, so a failed publish never loses the message and can duplicate it at the
 * other destinations. The attempt that makes `config.maxAttempts` failures instead publishes the
 * copy to `config.deadLetterExchange`, with its routing key, its source queue in
 * SOURCE_QUEUE_HEADER and the error in ERROR_HEADER. When the publisher is not connected, the
 * attempt does not count: the message is requeued once the publisher is connected again. When
 * the retry copy or the dead letter cannot be published either, the message is requeued as it
 * is, after RETRY_BASE_DELAY_MS or once the publisher is connected again.
 *
 * Delivery is at most once on a fault that comes after a publish returned. The publisher's
 * channel is not a confirm channel, and publishes go out without the mandatory flag, so a publish
 * returns once the message is written to the channel, before the broker has taken it, and the
 * broker drops a message that no binding routes without telling the router. A copy lost that
 * way (the publisher's connection drops before the broker has it, or its destination routes it
 * nowhere) is not retried, as its source is acked by then; the same holds for a retry copy and a
 * dead letter. Waiting for the broker to confirm each publish would need a confirm channel, which
 * the publisher broker (@devvir/rabbitmq) does not open.
 *
 * An ack or nack on a closed channel is logged and dropped, since the broker redelivers the
 * message. A consumer the broker cancels, or a consumer that cannot be cancelled or consumed
 * again for backpressure, ends the process with exit code 1.
 *
 * Resolves, once every source queue is consumed, to the Routing that stops it.
 */
export const consumeAndRepublish = async (
  consumer: RabbitMQ.Broker,
  publisher: RabbitMQ.Broker,
  config: Config,
  backpressure: Backpressure | null,
): Promise<Routing> => {
  const channel = consumer.getChannel();

  if (! channel)
    throw new Error('No RabbitMQ channel available');

  await channel.prefetch(config.prefetch);

  const publish         = publisherOf(publisher);
  const publisherOnline = whenConnected(publisher);
  const inFlight        = tracked();

  /** Requeue a message unchanged, once the publisher is connected and no sooner than `ms` from now. */
  const requeue = async (source: string, msg: RabbitMQ.RawMessage, ms: number): Promise<void> => {
    if (publisher.getState() === 'connected') await delay(ms);
    else await publisherOnline();

    settle(source, 'nack', () => channel.nack(msg, false, true));
  };

  const sources = [...groupBySource(config.routes)].map(([queueName, routes]) => {
    const targets    = distinctDestinations(routes).map(toTarget);
    const logFailure = throttledFailureLog(queueName);

    /** Publish the message to every destination of the source queue. */
    const route = async (msg: RabbitMQ.RawMessage): Promise<void> => {
      const incomingKey = incomingRoutingKey(msg);

      for (const target of targets) {
        const headers = destinationHeaders(msg.properties?.headers, target.headers);

        await publish(target, msg, {
          routingKey: target.fixedRoutingKey ?? resolveRoutingKey(target.routingKey, incomingKey),
          persistent: msg.properties?.deliveryMode === 2,
          userId:     undefined,
          ...(headers ? { headers } : {}),
        });
      }
    };

    /** Retry or dead-letter a message whose routing failed, or requeue it when neither works. */
    const recover = async (msg: RabbitMQ.RawMessage, err: unknown): Promise<void> => {
      if (publisher.getState() !== 'connected') return requeue(queueName, msg, 0);

      const failed = attemptsOf(msg) + 1;
      const copy   = {
        persistent: msg.properties?.deliveryMode === 2,
        userId:     undefined,
        headers:    {
          ...(msg.properties?.headers ?? {}),
          [ATTEMPTS_HEADER]:    failed,
          [ROUTING_KEY_HEADER]: incomingRoutingKey(msg),
        },
      };

      try {
        if (failed >= config.maxAttempts) {
          await publish(deadLetterTarget(config.deadLetterExchange), msg, {
            ...copy,
            routingKey: incomingRoutingKey(msg),
            headers:    { ...copy.headers, [SOURCE_QUEUE_HEADER]: queueName, [ERROR_HEADER]: errorText(err) },
          });
          logger.error({ source: queueName, attempts: failed, exchange: config.deadLetterExchange }, 'Dead-lettered a message');
        } else {
          await delay(retryDelay(failed));
          await publish(retryTarget(queueName), msg, { ...copy, routingKey: queueName });
        }
      } catch (retryErr) {
        logger.warn({ err: retryErr, source: queueName }, 'Could not retry or dead-letter the message; requeueing it');

        return requeue(queueName, msg, RETRY_BASE_DELAY_MS);
      }

      settle(queueName, 'ack', () => channel.ack(msg));
    };

    const handleDelivery = async (msg: RabbitMQ.RawMessage | null): Promise<void> => {
      if (! msg) {
        logger.error({ source: queueName }, 'The broker cancelled the consumer; exiting');
        process.exit(1);
        return;
      }

      if (backpressure?.atCapacity()) void consuming.pause(backpressure);

      try {
        await route(msg);
      } catch (err) {
        logFailure(err);
        await recover(msg, err);
        return;
      }

      settle(queueName, 'ack', () => channel.ack(msg));
    };

    const handle = (msg: RabbitMQ.RawMessage | null): Promise<void> => inFlight.track(handleDelivery(msg));

    return { queueName, routes, handle };
  });

  const consuming = consumers(channel, sources);

  await consuming.start();

  for (const { queueName, routes } of sources) {
    logger.info({
      source: queueName,
      routes: routes.map(formatRoute),
    }, 'Route established');
  }

  return { stop: consuming.stop, settled: inFlight.settled };
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

/** A source queue and the handler of its deliveries. */
interface Source {
  queueName: string;
  handle: (msg: RabbitMQ.RawMessage | null) => Promise<void>;
}

/**
 * The consumers of the source queues on one channel. `pause` cancels every consumer, waits until
 * the backpressure gate has room and consumes every source queue again; a pause asked for while
 * one runs joins it. A consumer that cannot be cancelled or consumed again ends the process with
 * exit code 1, as the router cannot route without it. `stop` waits for a consume under way, then
 * cancels every consumer; once it is called, no source queue is consumed again.
 */
const consumers = (channel: RabbitMQ.RawChannel, sources: Source[]) => {
  const tags = new Map<string, string>();
  let consuming: Promise<void> = Promise.resolve();
  let pausing: Promise<void> | null = null;
  let stopped = false;

  const consumeAll = (): Promise<void> => (consuming = (async () => {
    for (const { queueName, handle } of sources) {
      if (stopped) return;
      if (tags.has(queueName)) continue;

      const { consumerTag } = await channel.consume(queueName, handle);

      tags.set(queueName, consumerTag);
    }
  })());

  // A tag leaves the map before its cancel, so a pause and a stop never cancel it twice.
  const cancelAll = async (): Promise<void> => {
    for (const [queueName, tag] of tags) {
      tags.delete(queueName);
      await channel.cancel(tag);
    }
  };

  const start = (): Promise<void> => consumeAll();

  const pause = (gate: Backpressure): Promise<void> => (pausing ??= (async () => {
    try {
      if (stopped) return;

      await consuming;
      await cancelAll();
      await gate.hold();
      await consumeAll();
    } catch (err) {
      logger.error({ err }, 'Could not cancel or restart the consumers for backpressure; exiting');
      process.exit(1);
    } finally {
      pausing = null;
    }
  })());

  const stop = async (): Promise<void> => {
    stopped = true;

    await consuming.catch(() => undefined);
    await cancelAll();
  };

  return { start, pause, stop };
};

/** The deliveries being handled: `track` counts one until it ends, `settled` waits for none. */
const tracked = () => {
  const running = new Set<Promise<void>>();

  const track = (work: Promise<void>): Promise<void> => {
    const tracking = work.finally(() => running.delete(tracking));

    running.add(tracking);

    return tracking;
  };

  const settled = async (): Promise<void> => {
    while (running.size > 0) await Promise.allSettled([...running]);
  };

  return { track, settled };
};

/** The back-off before retrying a message that has failed `failed` times. */
const retryDelay = (failed: number): number =>
  backoffDelay(failed, { baseMs: RETRY_BASE_DELAY_MS, maxMs: RETRY_MAX_DELAY_MS, jitter: 'none' });

/** How many times routing the message has failed before, by ATTEMPTS_HEADER. */
const attemptsOf = (msg: RabbitMQ.RawMessage): number => {
  const attempts = Number(msg.properties?.headers?.[ATTEMPTS_HEADER]);

  return Number.isInteger(attempts) && attempts > 0 ? attempts : 0;
};

/** The routing key the message first arrived with: ROUTING_KEY_HEADER on a retried copy. */
const incomingRoutingKey = (msg: RabbitMQ.RawMessage): string => {
  const kept = msg.properties?.headers?.[ROUTING_KEY_HEADER];

  if (typeof kept === 'string') return kept;
  if (Buffer.isBuffer(kept)) return kept.toString('utf8');

  return msg.fields?.routingKey || '';
};

/**
 * The headers a destination receives, or undefined when the incoming ones pass unchanged: the
 * router's own headers are removed, and an injected header replaces an incoming header of the
 * same name.
 */
const destinationHeaders = (
  incoming: Record<string, unknown> | undefined,
  injected: Record<string, string> | undefined,
): Record<string, unknown> | undefined => {
  const carriesOwn = incoming !== undefined && ROUTER_HEADERS.some((name) => name in incoming);

  if (! carriesOwn && ! injected) return undefined;

  const kept = Object.entries(incoming ?? {}).filter(([name]) => ! ROUTER_HEADERS.includes(name));

  return { ...Object.fromEntries(kept), ...injected };
};

/** The longest error text a dead letter carries. */
const MAX_ERROR_LENGTH = 1_000;

const errorText = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_LENGTH);

/** The target of a retried copy: the back of its source queue, through the default exchange. */
const retryTarget = (queue: string): Target =>
  ({ exchange: undefined, routingKey: undefined, fixedRoutingKey: queue, headers: undefined });

const deadLetterTarget = (exchange: string): Target =>
  ({ exchange, routingKey: undefined, fixedRoutingKey: undefined, headers: undefined });

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
