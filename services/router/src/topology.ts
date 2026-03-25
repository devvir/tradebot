import { RabbitMQ } from '@devvir/service-kit';
import type { Exchange, Route, Config } from './types';

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * Declare source queues/exchanges on the consumer broker.
 */
export const declareConsumerTopology = async (
  broker: RabbitMQ.Broker,
  config: Config,
): Promise<void> => {
  const topology = buildConsumerTopology(config.routes) as RabbitMQ.TopologySpec;

  await broker.declares(topology);
};

/**
 * Declare destination exchanges on the publisher broker.
 */
export const declarePublisherTopology = async (
  broker: RabbitMQ.Broker,
  config: Config,
): Promise<void> => {
  const topology = buildPublisherTopology(config.routes) as RabbitMQ.TopologySpec;

  await broker.declares(topology);
};

/**
 * Builds topology for the consumer broker: source queues and their exchange bindings.
 */
export const buildConsumerTopology = (routes: Route[]): RabbitMQ.TopologySpec => {
  const exchanges: NonNullable<RabbitMQ.TopologySpec['exchanges']> = {};
  const queues: NonNullable<RabbitMQ.TopologySpec['queues']> = {};

  const ensureExchange = (ex: Exchange) => {
    if (exchanges[ex.name]) return;
    const type = ex.type === 'default' ? 'direct' : (ex.type || 'fanout');
    exchanges[ex.name] = { type, queues: {} };
  };

  for (const { source } of routes) {
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
  }

  return {
    ...(Object.keys(exchanges).length > 0 ? { exchanges } : {}),
    ...(Object.keys(queues).length > 0 ? { queues } : {}),
  };
};

/**
 * Builds topology for the publisher broker: destination exchanges only.
 */
export const buildPublisherTopology = (routes: Route[]): RabbitMQ.TopologySpec => {
  const exchanges: NonNullable<RabbitMQ.TopologySpec['exchanges']> = {};
  const queues: NonNullable<RabbitMQ.TopologySpec['queues']> = {};

  const ensureExchange = (ex: Exchange) => {
    if (exchanges[ex.name]) return;
    const type = ex.type === 'default' ? 'direct' : (ex.type || 'fanout');
    exchanges[ex.name] = { type, queues: {} };
  };

  for (const { destination } of routes) {
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
