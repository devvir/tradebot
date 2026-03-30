import { logger } from '@devvir/service-kit';
import { sanitizeUrl, redactUrl, parseRules } from '@tradebot/utils';
import type { ParsedItem } from '@tradebot/utils';
import type { Config, Route, RouteSource, RouteDestination, Exchange, RoutingKeyConfig } from './types';

export const loadConfig = (): Config => {
  const config: Config = {
    rabbitmqUrl: sanitizeUrl(process.env.QUEUE_URL || ''),
    routes: parseRules(process.env.ROUTER_RULES || '').map((p) => ({
      source: toSource(p.source),
      destination: toDestination(p.destination),
    })),
    maxReady:    parseInt(process.env.ROUTER_MAX_READY    || '0'),
    watchQueues: (process.env.ROUTER_WATCH_QUEUES || '').split(',').map((s) => s.trim()).filter(Boolean),
  };

  validateConfig(config);

  logger.info({
    ...config,
    rabbitmqUrl: redactUrl(config.rabbitmqUrl),
  }, 'Configuration loaded and validated!');

  return config;
};

const validateConfig = (config: Config): void => {
  if (! config.rabbitmqUrl) throw new Error('QUEUE_URL is required');
  if (! config.routes.length) throw new Error('Router rules are required');
  if (config.maxReady > 0 && config.watchQueues.length === 0) throw new Error('ROUTER_WATCH_QUEUES is required when ROUTER_MAX_READY is set');
};

// ── Source / destination mapping ──────────────────────────────────────────────

const toSource = (item: ParsedItem): RouteSource => {
  if (! item.queue) throw new Error('Source must have a queue name');
  if (item.routingKey?.replace !== undefined)
    throw new Error('(key:match:replace) is only valid on destinations');

  return {
    queue: item.queue,
    exchange: item.exchange as Exchange | undefined,
    ...(item.routingKey?.value && item.exchange
      ? { bindingKey: item.routingKey.value }
      : {}),
  };
};

const toDestination = (item: ParsedItem): RouteDestination => ({
  queue:    item.queue,
  exchange: item.exchange as Exchange | undefined,
  ...(item.routingKey ? { routingKey: item.routingKey as RoutingKeyConfig } : {}),
  ...(item.headers    ? { headers: item.headers }                          : {}),
});

// ── Formatting ────────────────────────────────────────────────────────────────

const formatItem = (queue?: string, exchange?: Exchange, keySuffix?: string): string => {
  const q  = queue || '';
  const ex = exchange
    ? `@${exchange.type ? exchange.type + ':' : ''}${exchange.name}`
    : '';
  return `${q}${ex}${keySuffix || ''}`;
};

export const formatRoute = (route: Route): string => {
  const { source: s, destination: d } = route;
  const srcKey = s.bindingKey ? `(key:${s.bindingKey})` : '';

  const dstParts: string[] = [];
  if (d.routingKey) {
    dstParts.push(
      `key:${d.routingKey.value}${d.routingKey.replace !== undefined ? ':' + d.routingKey.replace : ''}`,
    );
  }
  if (d.headers) {
    for (const [name, value] of Object.entries(d.headers)) {
      dstParts.push(`header:${name}=${value}`);
    }
  }
  const dstKey = dstParts.length ? `(${dstParts.join(',')})` : '';

  return `${formatItem(s.queue, s.exchange, srcKey)} > ${formatItem(d.queue, d.exchange, dstKey)}`;
};

export default loadConfig();