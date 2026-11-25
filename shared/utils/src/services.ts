import SK, { type Service, type ServiceKit, type Spec, type Bindings, type ProviderSpec } from '@devvir/service-kit';
import type { TopologySpec } from '@devvir/rabbitmq';
import type { ServerResponse } from 'node:http';

const MESSAGE_LOG_INTERVAL = 20_000;

/**
 * Health limits of a message-tracking service.
 *   - inactivityMs:   the longest gap since the last message that is still healthy (default 30 s)
 *   - startupGraceMs: how long after start the first message may take to arrive (default 60 s)
 */
export interface MessageTracking {
  inactivityMs?:   number;
  startupGraceMs?: number;
}

interface SKFactorySpec extends Spec {
  rabbitmq?:      boolean | { topology?: TopologySpec };
  redis?:         boolean;
  trackMessages?: boolean | MessageTracking;
}

/**
 * Creates a pre-configured SK instance with tradebot conventions baked in:
 *   - Standard provider URLs from QUEUE_URL / CACHE_URL env vars
 *   - RabbitMQ always in Broker mode (useBroker: true)
 *   - Health check on port 3000
 *   - Optional message tracking with activity-based health (trackMessages: true, or the limits
 *     of MessageTracking). The service counts a message on each 'message' event. It answers 503
 *     when no message arrived within startupGraceMs of the 'started' event, or when inactivityMs
 *     passed since the last one; 200 otherwise.
 *
 * Accepts any valid SK spec field directly (name, state, config, etc.).
 * The shortcut keys (rabbitmq, redis, trackMessages) are translated
 * into their spec equivalents and merged with whatever the caller passed.
 *
 * Usage:
 *   SKFactory({
 *     name: 'writer',
 *     config,
 *     rabbitmq: { topology },
 *     redis: true,
 *     trackMessages: true,
 *   }).run(async (service) => { ... service.emit('message') ... });
 */
export const SKFactory = (factorySpec: SKFactorySpec): ServiceKit => {
  const { rabbitmq, redis, trackMessages, ...passthroughSpec } = factorySpec;

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

  if (redis) {
    providers.redis = {
      url:      process.env.CACHE_URL || '',
      password: process.env.CACHE_PASS || '',
      retry:    { strategy: 'exponential', attempts: 10 },
    };
  }

  const tracking   = typeof trackMessages === 'object' ? trackMessages : {};
  const trackState = trackMessages ? { messages: 0, startedAt: null, lastMessageAt: null } : {};

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
    const inactivityMs   = tracking.inactivityMs ?? 30_000;
    const startupGraceMs = tracking.startupGraceMs ?? 60_000;

    bindings.onStarted = (service: Service) => {
      service.setState('startedAt', Date.now());
    };

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
      const startedAt     = service.state('startedAt') as number;
      const lastMessageAt = service.state('lastMessageAt') as number | null;
      const messages      = service.state('messages') as number;
      const since         = lastMessageAt ?? startedAt;
      const limit         = lastMessageAt === null ? startupGraceMs : inactivityMs;
      const healthy       = Date.now() - since < limit;

      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ healthy, messages, startedAt, lastMessageAt }));
    };
  }

  return SK.create({ spec, bindings });
};