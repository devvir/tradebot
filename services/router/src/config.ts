import { logger } from '@devvir/service';
import { sanitizeUrl, redactUrl } from '@tradebot/utils';
import type { Config, Route, RouteSource, RouteDestination, Exchange } from './types';

const VALID_TYPES = new Set(['fanout', 'topic', 'headers', 'direct', 'default']);
const ITEM_RE = /^(?<queue>[\w.-]+)?(?:@(?:(?<type>\w+):)?(?<exchange>[\w.-]+))?(?:\(key:(?<key>[^:)]+)(?::(?<replace>[^)]*))?\))?$/;

export const loadConfig = (): Config => {
  const config: Config = {
    rabbitmqUrl: sanitizeUrl(process.env.RABBITMQ_URL || ''),
    routes: splitRules(process.env.ROUTER_RULES || '').map((p) => ({
      source: toSource(p.source),
      destination: toDestination(p.destination),
    })),
  };

  validateConfig(config);

  logger.info({
    ...config,
    rabbitmqUrl: redactUrl(config.rabbitmqUrl),
  }, 'Configuration loaded and validated!');

  return config;
};

const validateConfig = (config: Config): void => {
  if (! config.rabbitmqUrl) throw new Error('RABBITMQ_URL is required');
  if (! config.routes.length) throw new Error('Router rules are required');
};


// ── Step 1: Split raw string into normalized source/destination string pairs ──
const splitRules = (raw: string): Array<{ source: string; destination: string }> => {
  const ruleStrings = raw.replace(/\s/g, '').split('|').filter(Boolean);

  const pairs: Array<{ source: string; destination: string }> = [];

  for (const rule of ruleStrings) {
    const sides = rule.split('>');
    if (sides.length !== 2) {
      throw new Error(
        sides.length < 2
          ? `Rule missing '>': "${rule}"`
          : `Rule must have exactly one '>': "${rule}"`
      );
    }

    const sources = sides[0].split('&').filter(Boolean);
    const dests = sides[1].split('&').filter(Boolean);

    if (! sources.length) throw new Error(`No sources in rule: "${rule}"`);
    if (! dests.length) throw new Error(`No destinations in rule: "${rule}"`);

    for (const src of sources) {
      for (const dest of dests) {
        pairs.push({ source: src, destination: dest });
      }
    }
  }

  return pairs;
};

// ── Step 2: Parse a single item string via regex ──
const parseItem = (raw: string) => {
  const mainPart = raw.split('(')[0];
  if (! mainPart.includes('@') && mainPart.includes(':')) {
    throw new Error(
      `"${raw}" looks like an exchange spec but is missing "@". ` +
        `Use "@${mainPart}" for an exchange, or remove the colon if "${mainPart}" is a queue name.`
    );
  }

  if (raw.includes('(') && ! raw.endsWith(')')) {
    throw new Error(`Unclosed parenthesis in "${raw}"`);
  }

  const match = ITEM_RE.exec(raw);
  if (! match) throw new Error(`Invalid route item: "${raw}"`);

  const { queue, type, exchange, key, replace } = match.groups!;

  if (! queue && ! exchange) throw new Error(`Invalid route item: "${raw}"`);

  if (type && ! VALID_TYPES.has(type)) {
    throw new Error(
      `Invalid exchange type "${type}" in "${raw}". Valid types: ${[...VALID_TYPES].join(', ')}`
    );
  }

  return {
    queue: queue || undefined,
    exchange: exchange
      ? ({ name: exchange, type: (type as Exchange['type']) || undefined } as Exchange)
      : undefined,
    key: key || undefined,
    replace,
  };
};

const toSource = (raw: string): RouteSource => {
  const item = parseItem(raw);

  if (! item.queue) throw new Error(`Source must have a queue name. Context: "${raw}"`);
  if (item.replace) throw new Error(`(key:match:replace) is only valid on destinations "${raw}"`);

  return {
    queue: item.queue,
    exchange: item.exchange,
    ...(item.key && item.exchange ? { bindingKey: item.key } : {}),
  };
};

const toDestination = (raw: string): RouteDestination => {
  const item = parseItem(raw);

  return {
    queue: item.queue,
    exchange: item.exchange,
    ...(item.key ? { routingKey: {
        value: item.key,
        ...(item.replace ? { replace: item.replace } : {}),
      }} : {}),
  };
};

// ── Formatting ──
const formatItem = (queue?: string, exchange?: Exchange, keySuffix?: string): string => {
  const q = queue || '';
  const ex = exchange
    ? `@${exchange.type ? exchange.type + ':' : ''}${exchange.name}`
    : '';
  return `${q}${ex}${keySuffix || ''}`;
};

export const formatRoute = (route: Route): string => {
  const { source: s, destination: d } = route;
  const srcKey = s.bindingKey ? `(key:${s.bindingKey})` : '';
  const dstKey = d.routingKey
    ? `(key:${d.routingKey.value}${d.routingKey.replace !== undefined ? ':' + d.routingKey.replace : ''})`
    : '';
  return `${formatItem(s.queue, s.exchange, srcKey)} > ${formatItem(d.queue, d.exchange, dstKey)}`;
};
