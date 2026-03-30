import { logger } from '@devvir/service-kit';
import type { RabbitMQ } from '@devvir/service-kit';

type Broker = RabbitMQ.Broker;

const POLL_INTERVAL_MS = 10_000;
const RESUME_RATIO     = 0.9;
const PAUSE_RATIO      = 1.1;

/**
 * Returns a gate function that resolves immediately when all watched queues
 * are within capacity, or awaits until they drain.
 *
 * Queue depth is sampled on a timer (every 10 s) — not on every message.
 * Pause triggers at > limit × 1.1; resume triggers at < limit × 0.9.
 */
export const createBackpressureGate = (
  broker:      Broker,
  queueNames:  string[],
  limit:       number,
): (() => Promise<void>) => {
  type State = 'ok' | 'paused';

  let state: State            = 'ok';
  let gatePromise: Promise<void> | null = null;
  let resolveGate: (() => void) | null  = null;

  const pauseThreshold  = Math.ceil(limit * PAUSE_RATIO);
  const resumeThreshold = Math.floor(limit * RESUME_RATIO);

  const checkDepths = async (): Promise<void> => {
    const channel = broker.getChannel();
    if (! channel) return;

    const depths: { name: string; depth: number }[] = [];

    for (const name of queueNames) {
      try {
        const ok = await channel.checkQueue(name);
        depths.push({ name, depth: ok.messageCount });
      } catch {
        continue;  // queue may not exist yet
      }
    }

    if (depths.length === 0) return;

    const overloaded = depths.find(q => q.depth > pauseThreshold);
    const allClear   = depths.every(q => q.depth < resumeThreshold);

    if (state === 'ok' && overloaded) {
      state       = 'paused';
      gatePromise = new Promise<void>(resolve => { resolveGate = resolve; });
      logger.warn({ queue: overloaded.name, depth: overloaded.depth, limit: pauseThreshold }, 'Clerk paused: downstream queue at capacity');
    }

    if (state === 'paused' && allClear) {
      state = 'ok';
      resolveGate!();
      gatePromise = null;
      resolveGate = null;
      logger.info({ depths, limit: resumeThreshold }, 'Clerk resumed');
    }
  };

  const interval = setInterval(checkDepths, POLL_INTERVAL_MS);
  interval.unref();

  return async () => {
    if (gatePromise !== null) await gatePromise;
  };
};
