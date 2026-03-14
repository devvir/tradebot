import type { Binding, ExchangeSpec, TopologySpec } from './types';

const VALID_TYPES = new Set([ 'fanout', 'topic', 'direct', 'headers' ]);

// Matches: [type:]name[(key:pattern)]
const ITEM_RE = /^(?:(?<type>\w+):)?(?<name>[\w.-]+)(?:\(key:(?<key>[^)]+)\))?$/;

const extractKey = (raw: string): string | undefined =>
  ITEM_RE.exec(raw)?.groups?.key || undefined;

/**
 * Parse a PIPE_BINDINGS string into a list of raw bindings.
 */
export default (raw: string): Binding[] =>
  raw.replace(/\s/g, '').split('|').filter(Boolean).map(parseBinding);


const parseBinding = (rule: string): Binding => {
  const sides = rule.split('>');

  if (sides.length !== 2) {
    throw new Error(
      sides.length < 2
        ? `Binding missing '>': "${rule}"`
        : `Binding must have exactly one '>': "${rule}"`,
    );
  }

  const srcKey = extractKey(sides[0]);
  const dstKey = extractKey(sides[1]);

  if (dstKey) {
    throw new Error(`Routing key can only be set on the source side in "${rule}"`);
  }

  return {
    source:      parseExchangeSpec(sides[0]),
    destination: parseExchangeSpec(sides[1]),
    ...(srcKey ? { routingKey: srcKey } : {}),
  };
};

const parseExchangeSpec = (raw: string): ExchangeSpec => {
  const match = ITEM_RE.exec(raw);
  if (! match?.groups?.name) throw new Error(`Invalid exchange spec: "${raw}"`);

  const { type, name } = match.groups;

  if (type && ! VALID_TYPES.has(type)) {
    throw new Error(
      `Invalid exchange type "${type}" in "${raw}". Valid types: ${[...VALID_TYPES].join(', ')}`,
    );
  }

  return {
    name,
    ...(type ? { type: type as ExchangeSpec['type'] } : {}),
  };
};

/**
 * Apply per-exchange-type business rules and defaults.
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
  const exchanges: NonNullable<TopologySpec['exchanges']>       = {};
  const exchangeBindings: NonNullable<TopologySpec['exchangeBindings']> = [];

  const ensureExchange = ({ name, type }: ExchangeSpec) => {
    if (exchanges[name!]) return;
    exchanges[name!] = { type: type ?? 'fanout' };
  };

  for (const { source, destination, routingKey } of bindings) {
    ensureExchange(source);
    ensureExchange(destination);
    exchangeBindings.push({
      source:      source.name!,
      destination: destination.name!,
      ...(routingKey ? { routingKey } : {}),
    });
  }

  return { exchanges, exchangeBindings };
};
