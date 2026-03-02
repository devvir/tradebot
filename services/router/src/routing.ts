import { Exchange } from '@devvir/rabbitmq';
import { logger } from '@devvir/service';
import type { Broker } from '@devvir/rabbitmq';
import type { Route, RoutingKeyConfig } from './types';

const PREFETCH = 1000;

/** Setup routing consumers that republish messages to destinations, grouped by source queue. */
export const startConsuming = async (broker: Broker, routes: Route[]): Promise<void> => {
  const channel = broker.getChannel();
  if (! channel) throw new Error('No RabbitMQ channel available');

  // Group routes by source queue
  const bySource = new Map<string, Route[]>();

  for (const route of routes) {
    const key = route.source.queue;

    if (! bySource.has(key)) bySource.set(key, []);

    bySource.get(key)!.push(route);
  }

  for (const [queueName, queueRoutes] of bySource) {
    const sourceQueue = broker.getQueue(queueName);
    if (! sourceQueue) throw new Error(`Source queue not found: ${queueName}`);

    // Resolve destination targets upfront (outside the hot path)
    const targets = queueRoutes.map((route) => {
      const dest = route.destination;

      if (dest.exchange) {
        const exchange = broker.getExchange(dest.exchange.name);

        if (! exchange) throw new Error(`Destination exchange not found: ${dest.exchange.name}`);

        return { exchange, routingKey: dest.routingKey, fixedRoutingKey: undefined as string | undefined };
      }

      // Queue-only destination: publish to default exchange ('') with queue name as routing key
      return { exchange: new Exchange(channel, ''), routingKey: dest.routingKey, fixedRoutingKey: dest.queue! };
    });

    await sourceQueue.consume(async (_message, { ack, nack, original: rawMsg }) => {
      try {
        const incomingKey = rawMsg.fields?.routingKey || '';

        for (const target of targets) {
          const routingKey = target.fixedRoutingKey ?? resolveRoutingKey(target.routingKey, incomingKey);
          await target.exchange.republish(rawMsg, { routingKey });
        }

        ack();
      } catch (err) {
        logger.error({ err, source: queueName }, 'Failed to route message');
        nack(true);
      }
    }, { prefetch: PREFETCH });

    logger.info({
      source: queueName,
      destinations: queueRoutes.map((r) => {
        const d = r.destination;
        const q = d.queue || '';
        const ex = d.exchange ? `@${d.exchange.type || 'default'}:${d.exchange.name}` : '';
        return `${q}${ex}`;
      }),
    }, 'Route established');
  }
};

const resolveRoutingKey = (config: RoutingKeyConfig | undefined, incoming: string): string => {
  if (! config) return incoming;

  if (config.replace !== undefined) return incoming.replace(config.value, config.replace);

  return config.value;
};
