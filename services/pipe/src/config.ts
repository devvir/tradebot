import { logger } from '@devvir/service';
import { sanitizeUrl, redactUrl } from '@tradebot/utils';
import parseBindings from './bindings';
import type { Binding, Config, ExchangeSpec, TopologySpec } from './types';

export const loadConfig = (): Config => {
  const rabbitmqUrl = sanitizeUrl(process.env.RABBITMQ_URL || '');
  const bindings = withDefaults(parseBindings(process.env.PIPE_BINDINGS || ''));

  if (! rabbitmqUrl) throw new Error('RABBITMQ_URL is required');
  if (! bindings.length) throw new Error('PIPE_BINDINGS is required');

  const topology = buildTopology(bindings);

  logger.info({ rabbitmqUrl: redactUrl(rabbitmqUrl), topology }, 'Configuration loaded');

  return { rabbitmqUrl, topology };
};

/** Apply per-exchange-type business rules and defaults. */
const withDefaults = (bindings: Binding[]): Binding[] => bindings.map((binding) => {
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

/** Convert bindings (post-defaults) into a RabbitMQ topology spec. */
const buildTopology = (bindings: Binding[]): TopologySpec => {
  const exchanges: NonNullable<TopologySpec['exchanges']> = {};
  const exchangeBindings: NonNullable<TopologySpec['exchangeBindings']> = [];

  const ensureExchange = ({ name, type }: ExchangeSpec) => {
    if (exchanges[name]) return;
    exchanges[name] = { type: type ?? 'fanout' };
  };

  for (const { source, destination, routingKey } of bindings) {
    ensureExchange(source);
    ensureExchange(destination);
    exchangeBindings.push({
      source: source.name,
      destination: destination.name,
      ...(routingKey ? { routingKey } : {}),
    });
  }

  return { exchanges, exchangeBindings };
};
