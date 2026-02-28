import { keepAlive } from '@devvir/rabbitmq';
import { logger } from '@devvir/service';
import type { Broker, TopologySpec } from '@devvir/rabbitmq';
import { Config, Exchange, Route } from './types';

export const connectToQueue = async ({ rabbitmqUrl, routes } : Config): Promise<Broker> => {
  logger.info('Connecting to RabbitMQ...');

  const broker = await keepAlive(rabbitmqUrl);
  const topology = buildTopology(routes);

  return await broker.declares(topology as TopologySpec);
};

/**
 * Builds a RabbitMQ topology specification from the provided routing rules.
 */
export const buildTopology = (routes: Route[]): TopologySpec => {
  const exchanges: NonNullable<TopologySpec['exchanges']> = {};
  const queues: NonNullable<TopologySpec['queues']> = {};

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
