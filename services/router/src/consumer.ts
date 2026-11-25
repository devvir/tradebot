import { logger, RabbitMQ } from '@devvir/service-kit';
import type { Route, RouteDestination, RoutingKeyConfig, Config } from './types';
import { formatRoute } from './routes';

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * For each source queue, consume messages and republish them to every distinct destination of
 * the rules on that queue: rules that share a queue and name the same destination publish once.
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

  if (holdPublishing)
    channel.prefetch(1000);

  for (const [queueName, routes] of groupBySource(config.routes)) {
    const targets = resolveTargets(publisher, channel, routes);

    await channel.consume(queueName, async (msg) => {
      if (! msg) return;

      try {
        if (holdPublishing) await holdPublishing();

        const incomingKey = msg.fields?.routingKey || '';

        for (const target of targets) {
          const routingKey = target.fixedRoutingKey ?? resolveRoutingKey(target.routingKey, incomingKey);

          await target.exchange.republish(msg, {
            routingKey,
            ...(target.headers ? { headers: { ...(msg.properties?.headers ?? {}), ...target.headers } } : {}),
          });
        }

        channel.ack(msg);
      } catch (err) {
        logger.error({ err, source: queueName }, 'Failed to route message');
        channel.nack(msg, false, true);
      }
    });

    logger.info({
      source: queueName,
      routes: routes.map(formatRoute),
    }, 'Route established');
  }
};

// ── Private ───────────────────────────────────────────────────────────────────

interface Target {
  exchange: RabbitMQ.Exchange;
  routingKey: RoutingKeyConfig | undefined;
  fixedRoutingKey: string | undefined;
  headers: Record<string, string> | undefined;
}

const groupBySource = (routes: Route[]): Map<string, Route[]> => {
  const grouped = new Map<string, Route[]>();

  for (const route of routes) {
    const key = route.source.queue;

    if (! grouped.has(key)) grouped.set(key, []);

    grouped.get(key)!.push(route);
  }

  return grouped;
};

const resolveTargets = (broker: RabbitMQ.Broker, channel: any, routes: Route[]): Target[] => {
  return distinctDestinations(routes).map((dest) => {
    if (dest.exchange) {
      const exchange = broker.getExchange(dest.exchange.name);

      if (! exchange) throw new Error(`Destination exchange not found: ${dest.exchange.name}`);

      return { exchange, routingKey: dest.routingKey, fixedRoutingKey: undefined, headers: dest.headers };
    }

    return {
      exchange: new RabbitMQ.Exchange(channel, ''),
      routingKey: dest.routingKey,
      fixedRoutingKey: dest.queue!,
      headers: dest.headers,
    };
  });
};

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

const resolveRoutingKey = (config: RoutingKeyConfig | undefined, incoming: string): string => {
  if (! config) return incoming;

  if (config.replace !== undefined) return incoming.replace(config.value, config.replace);

  return config.value;
};
