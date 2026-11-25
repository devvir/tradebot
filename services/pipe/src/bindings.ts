import { parseRules } from '@tradebot/utils';
import type { ParsedItem } from '@tradebot/utils';
import type { RabbitMQ } from '@devvir/service-kit';
import type { Binding, PipeExchange, TopologySpec } from './types';

type ExchangeMap = NonNullable<TopologySpec['exchanges']>;

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * Parse a PIPE_BINDINGS string into a list of pipe-specific bindings.
 *
 * Accepted input is a subset of the shared rule grammar:
 *   (type:exchange | @exchange)[(key:pattern)] > [queue@](type:exchange | @exchange)
 *
 * Rejected:
 *   - a queue on the source side          (pipe sources are exchanges)
 *   - the default exchange                (type 'default')
 *   - a queue inside a direct destination (it cannot match the forwarded keys)
 *   - routingKey.replace                  (key:value:replace)
 *   - headers                             (header:name=value)
 *   - a routing key on the destination side
 *
 * Each exchange name has one type across all bindings: a mention without a type takes the type
 * given to that name elsewhere, and a name that is never typed is fanout. Two different types
 * for one name throw.
 */
const parseBindings = (raw: string): Binding[] => {
  const bindings = parseRules(raw).map(({ source, destination }): Binding => ({
    source:      pipeExchange(source, 'source'),
    destination: {
      ...pipeExchange(destination, 'destination'),
      ...(destination.queue ? { queue: destination.queue } : {}),
    },
    ...(source.routingKey ? { routingKey: source.routingKey.value } : {}),
  }));

  return resolveTypes(bindings).map((binding) => {
    const { destination } = binding;

    if (destination.queue && destination.type === 'direct')
      throw new Error(
        `Queue "${destination.queue}" inside direct exchange "${destination.name}" cannot match forwarded keys; ` +
        'use a topic or fanout destination',
      );

    return binding;
  });
};

export default parseBindings;

/**
 * Apply per-exchange-type defaults and business rules.
 */
export const withDefaults = (bindings: Binding[]): Binding[] => bindings.map((binding) => {
  const { source, routingKey } = binding;

  if (source.type === 'direct' && ! routingKey) {
    throw new Error(`
      Routing key is required for direct exchange "${source.name}".
      Use: direct:${source.name}(key:your-key) > ...
    `);
  }

  // Topic exchanges default to '#' (match all) when no key is specified.
  if (source.type === 'topic' && ! routingKey) {
    return { ...binding, routingKey: '#' };
  }

  return binding;
});

/**
 * Convert bindings (post-defaults) into a RabbitMQ topology spec. A destination queue is bound
 * to its exchange with '#'. Throws when one exchange name is given two types.
 */
export const buildTopology = (bindings: Binding[]): TopologySpec => {
  const exchanges:        ExchangeMap                                   = {};
  const exchangeBindings: NonNullable<TopologySpec['exchangeBindings']> = [];

  for (const { source, destination, routingKey } of bindings) {
    ensureExchange(exchanges, source);

    const entry = ensureExchange(exchanges, destination);

    if (destination.queue) {
      entry.queues                  ??= {};
      entry.queues[destination.queue] = { durable: true, routingKey: '#' };
    }

    exchangeBindings.push({
      source:      source.name,
      destination: destination.name,
      ...(routingKey ? { routingKey } : {}),
    });
  }

  return { exchanges, exchangeBindings };
};

// ── Internal ──────────────────────────────────────────────────────────────────

/** The broker type of an exchange: an exchange without a type is fanout. */
const resolveExchangeType = (ex: PipeExchange): RabbitMQ.ExchangeType => ex.type ?? 'fanout';

/** Two types for one exchange name. */
const typeConflict = (name: string, a: string, b: string): Error =>
  new Error(`Exchange "${name}" is given two types: ${a} and ${b}`);

/**
 * Record an exchange in a topology exchange map under its resolved type, and return its entry.
 * Throws when the map already holds the name under a different type.
 */
const ensureExchange = (exchanges: ExchangeMap, ex: PipeExchange): ExchangeMap[string] => {
  const type     = resolveExchangeType(ex);
  const existing = exchanges[ex.name];

  if (! existing) return (exchanges[ex.name] = { type });
  if (existing.type !== type) throw typeConflict(ex.name, existing.type ?? 'fanout', type);

  return existing;
};

/** Give every mention of an exchange the one type its name has across all bindings. */
const resolveTypes = (bindings: Binding[]): Binding[] => {
  const types = new Map<string, RabbitMQ.ExchangeType>();

  for (const { source, destination } of bindings) {
    for (const { name, type } of [source, destination]) {
      if (! type) continue;

      const existing = types.get(name);

      if (existing && existing !== type) throw typeConflict(name, existing, type);

      types.set(name, type);
    }
  }

  const typed = <T extends PipeExchange>(ex: T): T => ({ ...ex, type: resolveExchangeType({ ...ex, type: types.get(ex.name) }) });

  return bindings.map((binding) => ({
    ...binding,
    source:      typed(binding.source),
    destination: typed(binding.destination),
  }));
};

/** Check a parsed item against pipe's restrictions, and return its exchange. */
const pipeExchange = (item: ParsedItem, side: 'source' | 'destination'): PipeExchange => {
  const { exchange } = item;

  if (! exchange)
    throw new Error(`Pipe ${side} must be an exchange, not a bare queue`);

  if (exchange.type === 'default')
    throw new Error(`The default exchange cannot be used in pipe bindings ("${exchange.name}")`);

  if (side === 'source' && item.queue)
    throw new Error(
      `Pipe sources are exchanges; a queue prefix is only valid on the destination ("${item.queue}@${exchange.name}")`,
    );

  if (item.routingKey?.replace !== undefined)
    throw new Error(
      `(key:value:replace) is a router-only feature and cannot be used in pipe bindings`,
    );

  if (item.headers)
    throw new Error(
      `Header modifiers are a router-only feature and cannot be used in pipe bindings`,
    );

  if (side === 'destination' && item.routingKey)
    throw new Error(`Routing key can only be set on the source side in pipe bindings`);

  return exchange.type ? { name: exchange.name, type: exchange.type } : { name: exchange.name };
};
