import { logger } from '@devvir/service-kit';
import { redactUrl, parseRules } from '@tradebot/utils';
import type { ParsedItem, ParsedRule } from '@tradebot/utils';
import type { Config, Route, RouteSource, RouteDestination, Exchange } from './types';
import type { ExchangeMap } from './routes';
import {
  ensureExchange, resolveExchangeType, sourceBindingKey, destinationBindingKey, formatRoute, formatDestination,
} from './routes';

/** The name of the dead-letter exchange and of the dead-letter queue when neither is configured. */
export const DEFAULT_DEAD_LETTER_NAME = 'router.dead-letter';

export const loadConfig = (): Config => {
  const rules  = parseRules(process.env.ROUTER_RULES || '');
  const typeOf = resolveTypes(rules);

  const config: Config = {
    rabbitmqUrl: process.env.QUEUE_URL ?? '',
    routes: rules.map((p) => ({
      source:      toSource(p.source, typeOf),
      destination: toDestination(p.destination, typeOf),
    })),
    prefetch:    parseInteger('ROUTER_PREFETCH', 500, 1),
    maxReady:    parseInteger('ROUTER_MAX_READY', 0, 0),
    watchQueues: (process.env.ROUTER_WATCH_QUEUES || '').split(',').map((s) => s.trim()).filter(Boolean),
    maxAttempts: parseInteger('ROUTER_MAX_ATTEMPTS', 5, 1),
    deadLetterExchange: parseName('ROUTER_DEAD_LETTER_EXCHANGE', DEFAULT_DEAD_LETTER_NAME),
    deadLetterQueue:    parseName('ROUTER_DEAD_LETTER_QUEUE', DEFAULT_DEAD_LETTER_NAME),
  };

  validateConfig(config);

  logger.info({
    ...config,
    rabbitmqUrl: redactUrl(config.rabbitmqUrl),
    routes:      config.routes.map(formatRoute),
  }, 'Configuration loaded and validated!');

  return config;
};

// ── Environment values ────────────────────────────────────────────────────────

/**
 * Read an integer of at least `min` (0 or 1) from an environment variable; the fallback when it
 * is unset or empty. Anything else that is not a whole number of at least `min` throws.
 */
const parseInteger = (name: string, fallback: number, min: 0 | 1): number => {
  const raw = process.env[name]?.trim();

  if (! raw) return fallback;

  const n = Number(raw);

  if (! Number.isInteger(n) || n < min)
    throw new Error(`${name} must be a ${min === 0 ? 'non-negative' : 'positive'} integer, got "${raw}"`);

  return n;
};

/** Read a name from an environment variable, trimmed; the fallback when it is unset or blank. */
const parseName = (name: string, fallback: string): string => process.env[name]?.trim() || fallback;

// ── Validation ────────────────────────────────────────────────────────────────

/** Check the whole configuration, and throw every problem found in one error. */
const validateConfig = (config: Config): void => {
  if (! config.rabbitmqUrl) throw new Error('QUEUE_URL is required');
  if (! config.routes.length) throw new Error('Router rules are required');

  const errors: string[] = [];

  if (config.maxReady > 0 && config.watchQueues.length === 0)
    errors.push('ROUTER_WATCH_QUEUES is required when ROUTER_MAX_READY is set');
  if (config.maxReady === 0 && config.watchQueues.length > 0)
    errors.push('ROUTER_MAX_READY is required when ROUTER_WATCH_QUEUES is set');

  const seen = new Set<string>();

  for (const route of config.routes) {
    const formatted = formatRoute(route);

    if (seen.has(formatted)) errors.push(`Route "${formatted}" is given more than once`);
    seen.add(formatted);

    errors.push(...routeErrors(route));
  }

  errors.push(...sharedQueueErrors(config.routes));
  errors.push(...deadLetterErrors(config));

  if (errors.length)
    throw new Error(`Invalid router configuration:\n  - ${errors.join('\n  - ')}`);
};

const routeErrors = (route: Route): string[] => {
  const { source: s, destination: d } = route;
  const formatted = formatRoute(route);
  const errors: string[] = [];

  if (! s.exchange && s.bindingKey !== undefined)
    errors.push(`A bare source queue takes no (key:...); bind it with queue@type:exchange(key:...): "${formatted}"`);

  if (! d.exchange && d.routingKey)
    errors.push(`A bare destination queue is published to under its own name, so it takes no (key:...): "${formatted}"`);

  if (d.queue === s.queue)
    errors.push(`Route "${formatted}" delivers into its own source queue "${s.queue}"`);

  if (d.exchange && s.exchange && d.exchange.name === s.exchange.name)
    errors.push(`Route "${formatted}" publishes into its own source exchange "${s.exchange.name}"`);

  collectError(errors, () => sourceBindingKey(s));

  const { exchange, queue } = d;

  if (exchange && queue) collectError(errors, () => destinationBindingKey({ ...d, exchange, queue }));

  return errors;
};

/**
 * Every rule on a source queue receives every message of that queue. Rules may share a queue
 * when they read it from the same exchange, and either bind it with the same key or deliver to
 * the same destinations (their keys then add up to the queue's bindings).
 */
const sharedQueueErrors = (routes: Route[]): string[] => {
  const byQueue = new Map<string, Route[]>();

  for (const route of routes) {
    const group = byQueue.get(route.source.queue) ?? [];

    group.push(route);
    byQueue.set(route.source.queue, group);
  }

  const errors: string[] = [];

  for (const [queue, group] of byQueue) {
    const exchanges = new Set(group.map(({ source: s }) => (s.exchange ? `${resolveExchangeType(s.exchange)}:${s.exchange.name}` : '')));

    if (exchanges.size > 1) {
      errors.push(`Source queue "${queue}" is read from different exchanges by different rules; use distinct source queues`);
      continue;
    }

    const destinationsByKey = new Map<string, Set<string>>();

    for (const { source, destination } of group) {
      const key = tryOrUndefined(() => JSON.stringify(sourceBindingKey(source) ?? null));

      if (key === undefined) continue; // reported by routeErrors

      const destinations = destinationsByKey.get(key) ?? new Set<string>();

      destinations.add(formatDestination(destination));
      destinationsByKey.set(key, destinations);
    }

    const destinationSets = new Set([...destinationsByKey.values()].map((set) => [...set].sort().join(' & ')));

    if (destinationSets.size > 1) {
      errors.push(
        `Source queue "${queue}" is bound differently by rules with different destinations; ` +
        'a queue cannot filter per rule — use distinct source queues',
      );
    }
  }

  return errors;
};

/**
 * The dead-letter queue takes no part in any rule, so that a dead-lettered message is never
 * routed again; the dead-letter exchange takes none either, so that it keeps its own type.
 */
const deadLetterErrors = ({ routes, deadLetterExchange, deadLetterQueue }: Config): string[] => {
  const queues    = new Set(routes.flatMap(({ source, destination }) => [source.queue, destination.queue]));
  const exchanges = new Set(routes.flatMap(({ source, destination }) => [source.exchange?.name, destination.exchange?.name]));
  const errors: string[] = [];

  if (queues.has(deadLetterQueue))
    errors.push(`The dead-letter queue "${deadLetterQueue}" is a queue of a rule; set ROUTER_DEAD_LETTER_QUEUE to another name`);
  if (exchanges.has(deadLetterExchange))
    errors.push(`The dead-letter exchange "${deadLetterExchange}" is an exchange of a rule; set ROUTER_DEAD_LETTER_EXCHANGE to another name`);

  return errors;
};

const collectError = (errors: string[], check: () => unknown): void => {
  try {
    check();
  } catch (err) {
    errors.push((err as Error).message);
  }
};

const tryOrUndefined = <T>(fn: () => T): T | undefined => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};

// ── Source / destination mapping ──────────────────────────────────────────────

/**
 * One type per exchange name across every rule, source and destination alike. Throws when two
 * mentions give one name different types; a name that is never typed is fanout.
 */
const resolveTypes = (rules: ParsedRule[]): ((name: string) => NonNullable<Exchange['type']>) => {
  const declared: ExchangeMap = {};

  for (const { source, destination } of rules) {
    for (const { exchange } of [source, destination]) {
      if (exchange?.type) ensureExchange(declared, exchange);
    }
  }

  return (name) => declared[name]?.type ?? 'fanout';
};

/**
 * A source is a queue, optionally bound to an exchange with a key. Header modifiers and
 * (key:match:replace) belong to destinations, so a source carrying either throws. A key on a
 * bare source queue is kept, so validation reports it alongside the configuration's other problems.
 */
const toSource = (item: ParsedItem, typeOf: (name: string) => Exchange['type']): RouteSource => {
  if (! item.queue) throw new Error('Source must have a queue name');
  if (item.routingKey?.replace !== undefined)
    throw new Error('(key:match:replace) is only valid on destinations');
  if (item.headers)
    throw new Error(`(header:...) is only valid on destinations: "${item.queue}"`);
  if (item.exchange?.type === 'default')
    throw new Error(`The default exchange cannot be bound; use a bare queue name: "${item.queue}@default:${item.exchange.name}"`);

  return {
    queue: item.queue,
    ...(item.exchange   ? { exchange: { name: item.exchange.name, type: typeOf(item.exchange.name) } } : {}),
    ...(item.routingKey ? { bindingKey: item.routingKey.value }                                       : {}),
  };
};

const toDestination = (item: ParsedItem, typeOf: (name: string) => Exchange['type']): RouteDestination => ({
  ...(item.queue      ? { queue: item.queue }                                                       : {}),
  ...(item.exchange   ? { exchange: { name: item.exchange.name, type: typeOf(item.exchange.name) } } : {}),
  ...(item.routingKey ? { routingKey: item.routingKey }                                             : {}),
  ...(item.headers    ? { headers: item.headers }                                                   : {}),
});

export default loadConfig();
