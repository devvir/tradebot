import SK, { type Service, type ServiceKit, type Spec, type Bindings, type ProviderSpec } from '@devvir/service-kit';
import type { TopologySpec } from '@devvir/rabbitmq';
import type { ServerResponse } from 'node:http';

const MESSAGE_LOG_INTERVAL = 20_000;
const HEALTH_INACTIVITY_MS = 30_000;

export interface SKFactoryConfig {
  name:           string;
  rabbitmq?:      boolean | { topology?: TopologySpec };
  mongodb?:       boolean;
  redis?:         boolean;
  trackMessages?: boolean;
}

/**
 * Creates a pre-configured SK instance with tradebot conventions baked in:
 *   - Standard provider URLs from RABBITMQ_URL / MONGODB_URL / REDIS_URL env vars
 *   - RabbitMQ always in Broker mode (useBroker: true)
 *   - Health check on port 3000
 *   - Optional message tracking with activity-based health (trackMessages: true)
 *
 * Usage:
 *   SKFactory({ name: 'writer', rabbitmq: { topology }, mongodb: true, redis: true, trackMessages: true })
 *     .declare({ config })
 *     .run(async (service) => { ... service.emit('message') ... });
 */
export const SKFactory = (config: SKFactoryConfig): ServiceKit => {
  const providers: Record<string, ProviderSpec> = {};

  if (config.rabbitmq) {
    providers.rabbitmq = {
      url:       process.env.RABBITMQ_URL || '',
      useBroker: true,
      retry:     { strategy: 'exponential', attempts: 10 },
      ...(typeof config.rabbitmq === 'object' && config.rabbitmq.topology
        ? { topology: config.rabbitmq.topology }
        : {}),
    };
  }

  if (config.mongodb) {
    providers.mongodb = {
      url:   process.env.MONGODB_URL || '',
      retry: { strategy: 'exponential', attempts: 10 },
    };
  }

  if (config.redis) {
    providers.redis = {
      url:   process.env.REDIS_URL || '',
      retry: { strategy: 'exponential', attempts: 10 },
    };
  }

  const spec: Spec = {
    name:        config.name,
    healthcheck: { port: 3000 },
    ...(Object.keys(providers).length > 0 ? { providers } : {}),
    ...(config.trackMessages ? { state: { messages: 0, lastMessageAt: null } } : {}),
  };

  const bindings: Bindings = {};

  if (config.trackMessages) {
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
      const healthy       = lastMessageAt !== null && (Date.now() - lastMessageAt < HEALTH_INACTIVITY_MS);

      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ healthy, messages, lastMessageAt }));
    };
  }

  return SK.create({ spec, bindings });
};