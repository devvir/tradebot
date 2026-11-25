import { logger } from '@devvir/service-kit';
import type { RabbitMQ } from '@devvir/service-kit';
import type { Config } from './types';

/** How often the depths of the watched queues are read in the background. */
export const BACKPRESSURE_POLL_MS = 2_000;

/** How often a held gate reads the depth of the queue it waits on. */
export const PAUSED_POLL_MS = 1_000;

/** The shortest gap between two warnings that one watched queue does not exist. */
export const MISSING_QUEUE_WARN_MS = 60_000;

export interface BackpressureGate {
  /** Whether a watched queue is at or above the limit, by the cached depths. */
  atCapacity: () => boolean;
  /** Resolves once no watched queue is at or above the limit; at once when all have room. */
  hold: () => Promise<void>;
  /** Ends the background depth reads and closes the depth channel. */
  stop: () => Promise<void>;
}

/** The ready-message count of a queue, or undefined when it cannot be read right now. */
type GetDepth = (name: string) => Promise<number | undefined>;

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * A gate that tells when any watched queue (`config.watchQueues`) holds `config.maxReady` ready
 * messages or more, and waits until none does. Null when backpressure is off: `maxReady` is 0 or
 * less, or no queue is watched.
 *
 * Depths are read once before the gate is returned, then every BACKPRESSURE_POLL_MS in the
 * background, so `atCapacity()` and `hold()` compare cached depths with no call to the broker.
 * A cached depth can be up to one background read old. When a queue is at or above the limit,
 * `hold()` waits, reading that queue's depth every PAUSED_POLL_MS, until no watched queue is at
 * or above it. Callers that arrive while the gate holds share that wait and are released
 * together.
 *
 * Each depth is a passive queue check on a channel of the broker's connection that serves only
 * these checks, so a failed check never closes the broker's own channel. That channel is opened
 * on first use, and again on the next read after it closes. A watched queue that does not exist
 * counts as depth 0, with a warning at most once per MISSING_QUEUE_WARN_MS. A depth that cannot
 * be read (an error, or no connection) keeps its last value, and counts as 0 until one is read:
 * the gate fails open.
 */
export const createBackpressureGate = async (
  broker: RabbitMQ.Broker,
  config: Config,
): Promise<BackpressureGate | null> => {
  if (config.maxReady <= 0 || config.watchQueues.length === 0) return null;

  const depths = depthReader(broker);
  const gate   = createGate(config.watchQueues, depths.getDepth, config.maxReady);

  await gate.poll();

  return {
    atCapacity: gate.atCapacity,
    hold:       gate.hold,
    stop: async () => {
      gate.stop();
      await depths.close();
    },
  };
};

// ── Private ───────────────────────────────────────────────────────────────────

/**
 * Read queue depths on a channel of their own, opened from the broker's connection. A missing
 * queue reads as 0; no connection reads as undefined; any other failure rejects.
 */
const depthReader = (broker: RabbitMQ.Broker): { getDepth: GetDepth; close: () => Promise<void> } => {
  let channel: Promise<RabbitMQ.RawChannel> | null = null;
  const missingWarnedAt = new Map<string, number>();

  const openChannel = (connection: RabbitMQ.RawConnection): Promise<RabbitMQ.RawChannel> => {
    const opening = connection.createChannel().then((ch) => {
      // A failed check closes the channel with an error; the check rejects with it as well and
      // is handled there, so the event needs no handling beyond keeping it from throwing.
      ch.on('error', () => {});
      ch.once('close', () => { if (channel === opening) channel = null; });

      return ch;
    });

    opening.catch(() => { if (channel === opening) channel = null; });

    return opening;
  };

  const warnMissing = (name: string): void => {
    const now = Date.now();

    if (now - (missingWarnedAt.get(name) ?? -Infinity) < MISSING_QUEUE_WARN_MS) return;

    missingWarnedAt.set(name, now);
    logger.warn({ queue: name }, 'Watched queue does not exist; counting its depth as 0');
  };

  const getDepth: GetDepth = async (name) => {
    const connection = broker.getConnection();

    if (! connection) return undefined;

    const ch = await (channel ??= openChannel(connection));

    try {
      return (await ch.checkQueue(name)).messageCount;
    } catch (err) {
      if ((err as { code?: unknown }).code !== 404) throw err;

      warnMissing(name);

      return 0;
    }
  };

  const close = async (): Promise<void> => {
    const open = channel;

    channel = null;

    try {
      await (await open)?.close();
    } catch {
      // Already closed.
    }
  };

  return { getDepth, close };
};

const createGate = (queueNames: string[], getDepth: GetDepth, maxReady: number) => {
  const cachedDepths = new Map(queueNames.map((name) => [name, 0]));

  /** Read one queue's depth into the cache; a depth that cannot be read keeps its last value. */
  const refresh = async (name: string): Promise<void> => {
    try {
      const depth = await getDepth(name);

      if (depth !== undefined) cachedDepths.set(name, depth);
    } catch (err) {
      logger.warn({ err, queue: name }, 'Could not read the queue depth; keeping the last one');
    }
  };

  let polling = false;

  /** Read every watched queue's depth; a read that starts while another runs is skipped. */
  const poll = async (): Promise<void> => {
    if (polling) return;

    polling = true;

    try {
      for (const name of queueNames) await refresh(name);
    } finally {
      polling = false;
    }
  };

  const interval = setInterval(() => void poll(), BACKPRESSURE_POLL_MS);

  interval.unref();

  const fullQueue = (): string | undefined => queueNames.find((name) => cachedDepths.get(name)! >= maxReady);

  const waitForRoom = async (full: string): Promise<void> => {
    logger.warn({ depth: cachedDepths.get(full), limit: maxReady, queue: full }, 'Router paused: downstream queue at capacity');

    let waitingOn: string | undefined = full;

    while (waitingOn !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, PAUSED_POLL_MS));
      await refresh(waitingOn);
      waitingOn = fullQueue();
    }

    logger.info({ limit: maxReady, queues: Object.fromEntries(cachedDepths) }, 'Router resumed');
  };

  // Shared gate: while one caller waits for room, every other caller awaits the same promise.
  let gatePromise: Promise<void> | null = null;

  const hold = async (): Promise<void> => {
    if (gatePromise !== null) return gatePromise;

    const full = fullQueue();

    if (full === undefined) return;

    let release!: () => void;

    gatePromise = new Promise<void>((resolve) => { release = resolve; });

    try {
      await waitForRoom(full);
    } finally {
      gatePromise = null;
      release();
    }
  };

  return { atCapacity: () => fullQueue() !== undefined, hold, poll, stop: () => clearInterval(interval) };
};
