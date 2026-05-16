import SK, { type Service, type ServiceKit, type Spec, type Bindings, type ProviderSpec } from '@devvir/service-kit';
import type { TopologySpec } from '@devvir/rabbitmq';
import type { ServerResponse } from 'node:http';

const MESSAGE_LOG_INTERVAL = 20_000;
const HEALTH_INACTIVITY_MS = 30_000;

interface SKFactorySpec extends Spec {
  rabbitmq?:      boolean | { topology?: TopologySpec };
  mongodb?:       boolean;
  redis?:         boolean;
  trackMessages?: boolean;
}

/**
 * Creates a pre-configured SK instance with tradebot conventions baked in:
 *   - Standard provider URLs from QUEUE_URL / DB_URL / CACHE_URL env vars
 *   - RabbitMQ always in Broker mode (useBroker: true)
 *   - Health check on port 3000
 *   - Optional message tracking with activity-based health (trackMessages: true)
 *
 * Accepts any valid SK spec field directly (name, state, config, etc.).
 * The shortcut keys (rabbitmq, mongodb, redis, trackMessages) are translated
 * into their spec equivalents and merged with whatever the caller passed.
 *
 * Usage:
 *   SKFactory({
 *     name: 'writer',
 *     config,
 *     rabbitmq: { topology },
 *     mongodb: true,
 *     redis: true,
 *     trackMessages: true,
 *   }).run(async (service) => { ... service.emit('message') ... });
 */
export const SKFactory = (factorySpec: SKFactorySpec): ServiceKit => {
  const { rabbitmq, mongodb, redis, trackMessages, ...passthroughSpec } = factorySpec;

  const providers: Record<string, ProviderSpec> = { ...passthroughSpec.providers };

  if (rabbitmq) {
    providers.rabbitmq = {
      url:       process.env.QUEUE_URL || '',
      useBroker: true,
      retry:     { strategy: 'exponential', attempts: 10 },
      ...(typeof rabbitmq === 'object' && rabbitmq.topology
        ? { topology: rabbitmq.topology }
        : {}),
    };
  }

  if (mongodb) {
    providers.mongodb = {
      url:   process.env.DB_URL || '',
      retry: { strategy: 'exponential', attempts: 10 },
    };
  }

  if (redis) {
    providers.redis = {
      url:      process.env.CACHE_URL || '',
      password: process.env.CACHE_PASS || '',
      retry:    { strategy: 'exponential', attempts: 10 },
    };
  }

  const trackState = trackMessages ? { messages: 0, lastMessageAt: null } : {};

  const spec: Spec = {
    ...passthroughSpec,
    healthcheck: passthroughSpec.healthcheck ?? { port: 3000 },
    ...(Object.keys(providers).length > 0 ? { providers } : {}),
    ...(Object.keys({ ...trackState, ...passthroughSpec.state }).length > 0
      ? { state: { ...trackState, ...passthroughSpec.state } }
      : {}),
  };

  const bindings: Bindings = {};

  if (trackMessages) {
    bindings.onMessage = async (service: Service) => {
      service.increment('messages');
      service.setState('lastMessageAt', Date.now());

      const messages = service.state('messages') as number;

      if (messages % MESSAGE_LOG_INTERVAL === 0) {
        service.logger.info(messages < 1_000_000
          ? `Processed ${(messages / 1_000).toFixed(0)}K messages`
          : `Processed ${(messages / 1_000_000).toFixed(2)}M messages`);
      }
    };

    bindings.onHealthCheck = (service: Service, res: ServerResponse) => {
      const lastMessageAt = service.state('lastMessageAt') as number | null;
      const messages      = service.state('messages') as number;
      const healthy       = lastMessageAt === null || (Date.now() - lastMessageAt < HEALTH_INACTIVITY_MS);

      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ healthy, messages, lastMessageAt }));
    };
  }

  return SK.create({ spec, bindings });
};