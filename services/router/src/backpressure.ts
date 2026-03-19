import { logger, RabbitMQ } from '@devvir/service-kit';
import type { Config } from './types';

const BACKPRESSURE_POLL_MS = 2_000;

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * Returns a gate function that resolves immediately when all watched queues
 * have room, or waits until each drops below maxReady. Returns null when
 * backpressure is disabled.
 *
 * Uses channel.checkQueue (passive) to inspect any queue in RabbitMQ — the
 * queue does not need to be declared in this service's topology.
 * Queue depths are polled in the background every BACKPRESSURE_POLL_MS so the
 * gate check is a cached read with no RPC on the hot path.
 */
export const createBackpressureGate = (
  broker: RabbitMQ.Broker,
  config: Config,
): (() => Promise<void>) | null => {
  if (config.maxReady <= 0 || config.watchQueues.length === 0) return null;

  const getDepth = async (name: string): Promise<number> => {
    const channel = broker.getChannel();

    if (! channel) return 0;

    const ok = await channel.checkQueue(name);

    return ok.messageCount;
  };

  return createHoldPublishing(config.watchQueues, getDepth, config.maxReady);
};

// ── Private ───────────────────────────────────────────────────────────────────

const createHoldPublishing = (
  queueNames: string[],
  getDepth: (name: string) => Promise<number>,
  maxReady: number,
) => {
  const cachedDepths = new Map(queueNames.map((name) => [name, 0]));

  const interval = setInterval(async () => {
    for (const name of queueNames) {
      cachedDepths.set(name, await getDepth(name));
    }
  }, BACKPRESSURE_POLL_MS);

  interval.unref();

  return async () => {
    for (const name of queueNames) {
      let depth = cachedDepths.get(name)!;

      if (depth < maxReady) continue;

      logger.warn({ depth, limit: maxReady, queue: name }, 'Router paused: downstream queue at capacity');

      while (depth >= maxReady) {
        await new Promise((r) => setTimeout(r, 1000));
        depth = await getDepth(name);
        cachedDepths.set(name, depth);
      }

      logger.info({ depth, limit: maxReady, queue: name }, 'Router resumed');
    }
  };
};
