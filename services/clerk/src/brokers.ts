/**
 * Broker pool: one RabbitMQ broker per worker.
 *
 * Each broker has its own TCP connection, its own channel, and its own
 * topology declaration. Workers publish through their dedicated broker so
 * backpressure on one worker's channel cannot stall the others.
 *
 * Topology is declared by every broker — `assertExchange` is idempotent on
 * the broker side, so multiple connections asserting the same exchange is
 * safe and produces no conflict.
 */

import { Broker, BackpressureGuard, type TopologySpec } from '@devvir/rabbitmq';

/** Shared topology declared on every broker in the pool. */
const TOPOLOGY: TopologySpec = {
  exchanges: {
    clerk: { type: 'topic' },
  },
};

/**
 * Creates `count` fully-connected brokers, each with the topology declared.
 * Brokers are unlimited-retry so they survive transient RabbitMQ blips.
 */
export const createBrokerPool = async (url: string, count: number): Promise<Broker[]> => {
  return Promise.all(
    Array.from({ length: count }, () => createBroker(url)),
  );
};

/**
 * Wires a single `BackpressureGuard` into every broker's exchange so all of
 * them share one queue-depth poller. Without this, each broker would create
 * its own guard on first publish and we'd be hammering the management API N×.
 *
 * Returns the guard so the caller can stop it on shutdown.
 */
export const installSharedBackpressureGuard = (
  brokers: Broker[],
  url:     string,
  waitIf:  Record<string, number>,
): BackpressureGuard => {
  const guard = new BackpressureGuard({
    amqpUrl:           url,
    waitIf,
    waitCheckInterval: 30,
  });

  guard.start();

  for (const broker of brokers) {
    broker.getExchange()!.setBackpressureGuard(guard);
  }

  return guard;
};

/** Closes every broker in the pool. Errors during teardown are tolerated. */
export const closeBrokerPool = async (brokers: Broker[]): Promise<void> => {
  await Promise.allSettled(brokers.map(b => b.close()));
};

// ── Private ───────────────────────────────────────────────────────────────────

const createBroker = async (url: string): Promise<Broker> => {
  const broker = new Broker(url, { retries: -1 });

  broker.connect();
  await broker.ensureConnected();
  await broker.declares(TOPOLOGY);

  return broker;
};
