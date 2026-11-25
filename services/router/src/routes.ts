import type { RabbitMQ } from '@devvir/service-kit';
import type { Exchange, Route, RouteSource, RouteDestination } from './types';

export type ExchangeMap = NonNullable<RabbitMQ.TopologySpec['exchanges']>;

// ── Exchange types ────────────────────────────────────────────────────────────

/** The broker type of an exchange: 'default' is a direct exchange, and an untyped one is fanout. */
export const resolveExchangeType = (ex: Exchange): RabbitMQ.ExchangeType =>
  ex.type === 'default' ? 'direct' : (ex.type ?? 'fanout');

/**
 * Record an exchange in a topology exchange map under its resolved type, and return its entry.
 * Throws when the map already holds the name under a different type.
 */
export const ensureExchange = (exchanges: ExchangeMap, ex: Exchange): ExchangeMap[string] => {
  const type     = resolveExchangeType(ex);
  const existing = exchanges[ex.name];

  if (existing) {
    if (existing.type !== type)
      throw new Error(`Exchange "${ex.name}" is given two types: ${existing.type} and ${type}`);

    return existing;
  }

  return (exchanges[ex.name] = { type, queues: {} });
};

/**
 * Add a queue to an exchange entry, accumulating its binding keys. An undefined key adds the
 * queue without a key of its own.
 */
export const bindQueue = (entry: ExchangeMap[string], queue: string, key: string | undefined): void => {
  const queues = (entry.queues ??= {});
  const spec   = (queues[queue] ??= { durable: true });

  if (key === undefined) return;

  const keys = Array.isArray(spec.routingKey) ? spec.routingKey : spec.routingKey ? [spec.routingKey] : [];

  if (! keys.includes(key)) spec.routingKey = [...keys, key];
};

// ── Binding keys ──────────────────────────────────────────────────────────────

/**
 * The key a source queue is bound to its exchange with: the configured key, or '#' on a topic
 * exchange. A direct exchange requires a configured key. Fanout and headers exchanges ignore keys.
 */
export const sourceBindingKey = (source: RouteSource): string | undefined => {
  if (! source.exchange) return undefined;

  const type = resolveExchangeType(source.exchange);

  if (source.bindingKey !== undefined) return source.bindingKey;

  if (type === 'direct') {
    throw new Error(
      `Direct exchange "${source.exchange.name}" needs an explicit binding key: ` +
      `${source.queue}@direct:${source.exchange.name}(key:...)`,
    );
  }

  return type === 'topic' ? '#' : undefined;
};

/**
 * The key a destination queue is bound to its exchange with, so that it receives what the router
 * publishes there:
 *   - topic: the static key when the destination has one, otherwise '#' (pass-through and
 *     replaced keys vary per message)
 *   - direct: the static key; a pass-through or replaced key cannot be bound, so it throws
 *   - fanout, headers: '' (the broker ignores the key)
 */
export const destinationBindingKey = (dest: RouteDestination & { exchange: Exchange; queue: string }): string => {
  const type   = resolveExchangeType(dest.exchange);
  const key    = dest.routingKey;
  const fixed  = key && key.replace === undefined ? key.value : undefined;

  switch (type) {
    case 'topic':
      return fixed ?? '#';
    case 'direct':
      if (fixed === undefined) {
        throw new Error(
          `A queue on a direct destination needs a static (key:...): "${formatDestination(dest)}"`,
        );
      }
      return fixed;
    default:
      return '';
  }
};

// ── Formatting ────────────────────────────────────────────────────────────────

const formatItem = (queue?: string, exchange?: Exchange, modifiers: string[] = []): string => {
  const ex  = exchange ? `@${resolveExchangeType(exchange)}:${exchange.name}` : '';
  const mod = modifiers.length ? `(${modifiers.join(',')})` : '';

  return `${queue ?? ''}${ex}${mod}`;
};

/** A destination in rule syntax, with its exchange type resolved. */
export const formatDestination = (d: RouteDestination): string => {
  const modifiers: string[] = [];

  if (d.routingKey) {
    modifiers.push(
      `key:${d.routingKey.value}${d.routingKey.replace !== undefined ? ':' + d.routingKey.replace : ''}`,
    );
  }

  for (const [name, value] of Object.entries(d.headers ?? {})) {
    modifiers.push(`header:${name}=${value}`);
  }

  return formatItem(d.queue, d.exchange, modifiers);
};

/** A route in rule syntax, with its exchange types resolved. */
export const formatRoute = (route: Route): string => {
  const { source: s, destination: d } = route;
  const srcModifiers = s.bindingKey !== undefined ? [`key:${s.bindingKey}`] : [];

  return `${formatItem(s.queue, s.exchange, srcModifiers)} > ${formatDestination(d)}`;
};
