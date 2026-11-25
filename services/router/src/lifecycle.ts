import type { ServerResponse } from 'node:http';
import { logger, RabbitMQ } from '@devvir/service-kit';
import { retry } from '@tradebot/utils';
import type { Service } from '@devvir/service-kit';
import type { Routing } from './consumer';
import type { BackpressureGate } from './backpressure';

/** How many times the consumer broker tries to connect before the router gives up. */
export const CONNECT_ATTEMPTS = 10;

/** The wait before the second connect attempt; each further attempt doubles it. */
export const CONNECT_BASE_DELAY_MS = 500;

/** The longest wait between two connect attempts. */
export const CONNECT_MAX_DELAY_MS = 30_000;

/**
 * The longest the router waits at shutdown for its consumers to be cancelled and the deliveries
 * being handled to be settled. It stays under the 10 s Docker gives a container to stop before
 * killing it.
 */
export const SHUTDOWN_TIMEOUT_MS = 8_000;

/** What the router stops and closes at shutdown. */
export interface Lifecycles {
  consumer: RabbitMQ.Broker;
  publisher: RabbitMQ.Broker;
  routing: Routing;
  backpressure: Pick<BackpressureGate, 'stop'> | null;
}

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * The consumer broker, connected. It does not reconnect once connected: a lost connection emits
 * 'disconnect' (see exitOnConsumerLoss). Up to CONNECT_ATTEMPTS attempts are made, waiting
 * CONNECT_BASE_DELAY_MS before the second, doubled before each further one up to
 * CONNECT_MAX_DELAY_MS; rejects with the error of the last one.
 */
export const connectConsumer = async (url: string): Promise<RabbitMQ.Broker> => {
  const broker = new RabbitMQ.Broker(url, { retries: 0, managed: true });

  await retry(() => broker.ensureConnected(), {
    attempts: CONNECT_ATTEMPTS,
    baseMs:   CONNECT_BASE_DELAY_MS,
    maxMs:    CONNECT_MAX_DELAY_MS,
    jitter:   'none',
    onRetry:  (err, attempt, retryInMs) => logger.warn({ err, attempt, retryInMs }, 'Could not connect the consumer to RabbitMQ; retrying'),
  });

  return broker;
};

/**
 * On service shutdown, stop routing before the brokers close, so that no delivery is cut off
 * between its publishes and its ack: the backpressure gate stops, every source consumer is
 * cancelled, and the deliveries being handled are waited for, all within `timeoutMs`. Then the
 * publisher closes, and the consumer last. A delivery still being handled at the deadline is
 * left unacked, and the broker redelivers it, so it can reach a destination twice. A failure to
 * stop is logged, and the brokers close all the same.
 */
export const stopOnShutdown = (service: Service, lifecycles: Lifecycles, timeoutMs = SHUTDOWN_TIMEOUT_MS): void => {
  const { consumer, publisher, routing, backpressure } = lifecycles;

  service.on('shutdown', async () => {
    const stopping = (async () => {
      await backpressure?.stop();
      await routing.stop();
      await routing.settled();
    })();

    try {
      if (! await within(stopping, timeoutMs))
        logger.warn({ timeoutMs }, 'Deliveries were still being handled at shutdown; the broker redelivers them');
    } catch (err) {
      logger.error({ err }, 'Could not stop routing at shutdown');
    }

    await closeQuietly('publisher', publisher);
    await closeQuietly('consumer', consumer);
  });
};

/**
 * End the process with exit code 1 when the consumer broker loses its connection: it disconnects
 * (it does not reconnect) or aborts. A broker that is closed on purpose emits neither event.
 */
export const exitOnConsumerLoss = (consumer: RabbitMQ.Broker): void => {
  consumer.on('disconnect', () => exit('The consumer lost its RabbitMQ connection; exiting'));
  consumer.on('abort', (err?: Error) => exit('The consumer could not connect to RabbitMQ; exiting', err));
};

/** Answer the service health check: 200 while both brokers are connected, 503 otherwise. */
export const answerHealthCheck = (service: Service, consumer: RabbitMQ.Broker, publisher: RabbitMQ.Broker): void => {
  service.on('healthCheck', (_service: Service, res: ServerResponse) => {
    const brokers = { consumer: consumer.getState(), publisher: publisher.getState() };
    const healthy = brokers.consumer === 'connected' && brokers.publisher === 'connected';

    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ healthy, brokers }));
  });
};

// ── Private ───────────────────────────────────────────────────────────────────

const exit = (message: string, err?: Error): void => {
  logger.error(err ? { err } : {}, message);
  process.exit(1);
};

/** Whether the work ended within `ms`; rejects when it rejects within `ms`. */
const within = async (work: Promise<void>, ms: number): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });

  try {
    return await Promise.race([work.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const closeQuietly = async (name: string, broker: RabbitMQ.Broker): Promise<void> => {
  try {
    await broker.close();
  } catch (err) {
    logger.warn({ err, broker: name }, 'Could not close the broker');
  }
};
