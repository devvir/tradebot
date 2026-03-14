import type { RabbitMQ } from '@devvir/service-kit';
import type { Exchange, Route } from './types';

/**
 * Builds a RabbitMQ topology specification from the provided routing rules.
 */
export const buildTopology = (routes: Route[]): RabbitMQ.TopologySpec => {
  const exchanges: NonNullable<RabbitMQ.TopologySpec['exchanges']> = {};
  const queues: NonNullable<RabbitMQ.TopologySpec['queues']> = {};

  const ensureExchange = (ex: Exchange) => {
    if (exchanges[ex.name]) return;
    const type = ex.type === 'default' ? 'direct' : (ex.type || 'fanout');
    exchanges[ex.name] = { type, queues: {} };
  };

  for (const { source, destination } of routes) {
    if (source.exchange) {
      ensureExchange(source.exchange);
      const exType = exchanges[source.exchange.name].type;
      const bindingKey =
        source.bindingKey || (exType === 'topic' || exType === 'direct' ? '#' : undefined);
      exchanges[source.exchange.name].queues![source.queue] = {
        durable: true,
        ...(bindingKey ? { routingKey: bindingKey } : {}),
      };
    } else {
      queues[source.queue] = { durable: true };
    }

    if (destination.exchange) {
      ensureExchange(destination.exchange);
      if (destination.queue) {
        exchanges[destination.exchange.name].queues![destination.queue] = { durable: true };
      }
    } else if (destination.queue) {
      queues[destination.queue] = { durable: true };
    }
  }

  return {
    ...(Object.keys(exchanges).length > 0 ? { exchanges } : {}),
    ...(Object.keys(queues).length > 0 ? { queues } : {}),
  };
};
