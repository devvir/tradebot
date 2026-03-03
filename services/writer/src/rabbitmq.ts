import type { MongoClient, Document } from 'mongodb';
import { logger } from '@devvir/service';
import { keepAlive, Broker } from '@devvir/rabbitmq';
import type { ConsumerEvent } from '@devvir/rabbitmq';
import { type Config, type Batch, CONSUMER_QUEUES, DLQ, DLX, EXCHANGE } from './types';
import { resolveTarget, parseDocument, persistBatch } from './persistence';

// ── Constants ────────────────────────────────────────────────────────────────

const STALL_THRESHOLD_MS = 10_000;
const STALL_CHECK_INTERVAL_MS = 5_000;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Creates and configures a RabbitMQ broker.
 * Declares the writer topic exchange with archive, collect, and custom queues.
 */
export const connectToQueue = async (connectionUrl: string): Promise<Broker> => {
  logger.info('Setting up RabbitMQ broker...');

  const broker = await keepAlive(connectionUrl);

  return broker.declares({
    exchanges: {
      [EXCHANGE]: {
        type: 'topic',
        queues: {
          [CONSUMER_QUEUES.archive]: { routingKey: 'archive.*', deadLetterExchange: DLX },
          [CONSUMER_QUEUES.collect]: { routingKey: 'collect.*', deadLetterExchange: DLX },
          [CONSUMER_QUEUES.custom]:  { routingKey: 'custom.*.*', deadLetterExchange: DLX },
        },
      },

      /** Dead-letter exchange */
      [DLX]: { type: 'fanout', queues: { [DLQ]: {} } },
    },
  });
};

/**
 * Start consuming from all writer queues (archive, collect, custom).
 * Each queue accumulates messages into per-collection batches and flushes
 * via persistence layer.
 */
export const startConsuming = async (
  broker: Broker,
  mongo: MongoClient,
  config: Config,
  onStoreMsg: () => void,
): Promise<void> => {
  for (const queueName of Object.values(CONSUMER_QUEUES)) {
    logger.debug({ queue: queueName }, 'Consuming from queue');
    await consumeWithBatching(broker, mongo, config, queueName, onStoreMsg);
  }
};

// ── Batching consumer ────────────────────────────────────────────────────────

/**
 * Batching consumer: accumulates messages into per-collection batches and
 * flushes them via persistBatch. Prevents the thundering-herd problem
 * where WRITER_PREFETCH concurrent insertOne calls saturate MongoDB.
 *
 * Flush triggers:
 *  - batch reaches insertBatchSize documents
 *  - flushIntervalMs elapses since the last flush schedule
 */
const consumeWithBatching = async (
  broker: Broker,
  mongo: MongoClient,
  config: Config,
  queueName: string,
  onStoreMsg: () => void,
): Promise<void> => {
  const { insertBatchSize, flushIntervalMs } = config;

  const pending = new Map<string, Batch>();
  let flushTimer: NodeJS.Timeout | null = null;
  let hasReceivedMessages = false;
  let lastAckAt = Date.now();

  // ── Consumer ───────────────────────────────────────────────────────────

  await broker.consume(queueName, (_msg: unknown, event: ConsumerEvent) => {
    hasReceivedMessages = true;

    const { routingKey } = event.metadata;
    const target = resolveTarget(routingKey, config);

    if (! target) {
      logger.error({ routingKey }, 'Cannot resolve write target from routing key');
      return event.nack(false);
    }

    let document: Document;

    try {
      document = parseDocument(event);
    } catch (e) {
      logger.error({ err: e, routingKey }, 'Failed to parse message JSON — discarding');
      return event.nack(false);
    }

    const key = `${target.database}|${target.collection}`;

    if (! pending.has(key)) {
      pending.set(key, { entries: [], database: target.database, collection: target.collection });
    }

    const batch = pending.get(key)!;

    batch.entries.push({ event, document });
    (batch.entries.length >= insertBatchSize) ? flush(key) : scheduleFlush();
  }, { prefetch: config.prefetch });

  // ── Stall monitor ──────────────────────────────────────────────────────
  // Only warns when messages have been received but none acked recently
  // (ignores idle queues that simply have nothing to consume).
  const stallCheck = setInterval(() => {
    if (! hasReceivedMessages) return;

    const stalledMs = Date.now() - lastAckAt;

    if (stalledMs > STALL_THRESHOLD_MS) {
      logger.warn({ stalledMs, pending: pending.size, queue: queueName }, 'Writer stall detected — no messages acked');
    }
  }, STALL_CHECK_INTERVAL_MS);

  stallCheck.unref();

  // ── Flush helpers ──────────────────────────────────────────────────────

  const flush = (key: string): void => {
    const batch = pending.get(key);
    if (! batch || batch.entries.length === 0) return;

    const snapshot: Batch = {
      database: batch.database,
      collection: batch.collection,
      entries: batch.entries.splice(0),
    };

    pending.delete(key);

    persistBatch(mongo, snapshot, queueName, () => {
      lastAckAt = Date.now();
      onStoreMsg();
    }).catch(err => logger.error({ err, queueName }, 'Unexpected persistBatch error'));
  };

  const flushAll = (): void => {
    for (const key of Array.from(pending.keys())) flush(key);
  };

  const scheduleFlush = (): void => {
    if (flushTimer) return;

    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushAll();
    }, flushIntervalMs);
  };
};
