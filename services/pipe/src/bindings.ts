import { parseRules } from '@tradebot/utils';
import type { ParsedItem } from '@tradebot/utils';
import type { Binding, DestinationSpec, ExchangeSpec, TopologySpec } from './types';

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * Parse a PIPE_BINDINGS string into a list of pipe-specific bindings.
 *
 * Accepted input is a subset of the shared rule grammar:
 *   [queue@]type:exchange[(key:pattern)] > [queue@]type:exchange
 *
 * Rejected (pipe has no message path — no transformation features):
 *   - routingKey.replace  (key:value:replace)
 *   - headers             (header:name=value)
 */
const parseBindings = (raw: string): Binding[] => {
  const rules = parseRules(raw);
  return rules.map(({ source, destination }) => {
    validatePipeItem(source, 'source');
    validatePipeItem(destination, 'destination');
    return toBinding(source, destination);
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
 * Convert bindings (post-defaults) into a RabbitMQ topology spec.
 */
export const buildTopology = (bindings: Binding[]): TopologySpec => {
  const exchanges:        NonNullable<TopologySpec['exchanges']>        = {};
  const exchangeBindings: NonNullable<TopologySpec['exchangeBindings']> = [];

  const ensureExchange = ({ name, type }: ExchangeSpec) => {
    if (exchanges[name!]) return;
    exchanges[name!] = { type: type ?? 'fanout' };
  };

  for (const { source, destination, routingKey } of bindings) {
    ensureExchange(source);
    ensureExchange(destination);

    if (destination.queue) {
      exchanges[destination.name!].queues                        ??= {};
      exchanges[destination.name!].queues![destination.queue] = { durable: true, routingKey: '#' };
    }

    exchangeBindings.push({
      source:      source.name!,
      destination: destination.name!,
      ...(routingKey ? { routingKey } : {}),
    });
  }

  return { exchanges, exchangeBindings };
};

// ── Internal ──────────────────────────────────────────────────────────────────

const validatePipeItem = (item: ParsedItem, side: 'source' | 'destination'): void => {
  if (! item.exchange)
    throw new Error(`Pipe ${side} must be an exchange, not a bare queue`);

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
};

const toBinding = (source: ParsedItem, destination: ParsedItem): Binding => ({
  source:      { name: source.exchange!.name, ...(source.exchange!.type ? { type: source.exchange!.type as ExchangeSpec['type'] } : {}) },
  destination: {
    name: destination.exchange!.name,
    ...(destination.exchange!.type ? { type: destination.exchange!.type as ExchangeSpec['type'] } : {}),
    ...(destination.queue          ? { queue: destination.queue }                                  : {}),
  } as DestinationSpec,
  ...(source.routingKey ? { routingKey: source.routingKey.value } : {}),
});
