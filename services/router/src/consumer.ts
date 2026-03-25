import { logger, RabbitMQ } from '@devvir/service-kit';
import type { Route, RoutingKeyConfig, Config } from './types';

// ── Public ────────────────────────────────────────────────────────────────────

/** For each source queue, consume messages and republish them to every configured destination. */
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
      destinations: routes.map(formatDestination),
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
  return routes.map((route) => {
    const dest = route.destination;

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

const resolveRoutingKey = (config: RoutingKeyConfig | undefined, incoming: string): string => {
  if (! config) return incoming;

  if (config.replace !== undefined) return incoming.replace(config.value, config.replace);

  return config.value;
};

const formatDestination = (route: Route): string => {
  const d = route.destination;
  const q = d.queue || '';
  const ex = d.exchange ? `@${d.exchange.type || 'default'}:${d.exchange.name}` : '';
  return `${q}${ex}`;
};
