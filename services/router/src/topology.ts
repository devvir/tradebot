import type { RabbitMQ } from '@devvir/service-kit';
import type { Route, Config } from './types';
import { ensureExchange, bindQueue, sourceBindingKey, destinationBindingKey } from './routes';

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * Declare source queues/exchanges on the consumer broker.
 */
export const declareConsumerTopology = async (
  broker: RabbitMQ.Broker,
  config: Config,
): Promise<void> => {
  await broker.declares(buildConsumerTopology(config.routes));
};

/**
 * Declare destination queues/exchanges, and the dead-letter exchange and queue, on the publisher
 * broker.
 */
export const declarePublisherTopology = async (
  broker: RabbitMQ.Broker,
  config: Config,
): Promise<void> => {
  await broker.declares(buildPublisherTopology(config.routes, {
    exchange: config.deadLetterExchange,
    queue:    config.deadLetterQueue,
  }));
};

/**
 * Builds topology for the consumer broker: source queues and their exchange bindings.
 * A source queue on an exchange is bound with every binding key its routes give it
 * (see sourceBindingKey).
 */
export const buildConsumerTopology = (routes: Route[]): RabbitMQ.TopologySpec => {
  const exchanges: NonNullable<RabbitMQ.TopologySpec['exchanges']> = {};
  const queues: NonNullable<RabbitMQ.TopologySpec['queues']> = {};

  for (const { source } of routes) {
    if (source.exchange) {
      bindQueue(ensureExchange(exchanges, source.exchange), source.queue, sourceBindingKey(source));
    } else {
      queues[source.queue] = { durable: true };
    }
  }

  return withEntries(exchanges, queues);
};

/** A fanout exchange and the durable queue bound to it, for messages the router dead-letters. */
export interface DeadLetter {
  exchange: string;
  queue: string;
}

/**
 * Builds topology for the publisher broker: destination exchanges, and destination queues
 * bound so that they receive what the router publishes (see destinationBindingKey). With a
 * dead letter, also its fanout exchange and its queue, bound to it.
 */
export const buildPublisherTopology = (routes: Route[], deadLetter?: DeadLetter): RabbitMQ.TopologySpec => {
  const exchanges: NonNullable<RabbitMQ.TopologySpec['exchanges']> = {};
  const queues: NonNullable<RabbitMQ.TopologySpec['queues']> = {};

  for (const { destination } of routes) {
    const { exchange, queue } = destination;

    if (exchange) {
      const entry = ensureExchange(exchanges, exchange);

      if (queue) bindQueue(entry, queue, destinationBindingKey({ ...destination, exchange, queue }));
    } else if (queue) {
      queues[queue] = { durable: true };
    }
  }

  if (deadLetter) bindQueue(ensureExchange(exchanges, { name: deadLetter.exchange, type: 'fanout' }), deadLetter.queue, '');

  return withEntries(exchanges, queues);
};

// ── Private ───────────────────────────────────────────────────────────────────

const withEntries = (
  exchanges: NonNullable<RabbitMQ.TopologySpec['exchanges']>,
  queues: NonNullable<RabbitMQ.TopologySpec['queues']>,
): RabbitMQ.TopologySpec => ({
  ...(Object.keys(exchanges).length > 0 ? { exchanges } : {}),
  ...(Object.keys(queues).length > 0 ? { queues } : {}),
});
