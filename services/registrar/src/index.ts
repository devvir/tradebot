import type { MongoClient } from 'mongodb';
import { type Service } from '@devvir/service-kit';
import SK from './service';
import { makeId } from './id';
import { flushBatch } from './insert';
import * as progress from './progress';
import type { Broker, ConsumerEvent, Config, PendingEntry, RedisClient, ControlMessage } from './types';

SK.run(async (service: Service) => {
  const config = service.config() as Config;

  const [ mongo, broker, redis ] = await service.providers.connect([
    'mongodb',
    'rabbitmq',
    'redis',
  ]) as [ MongoClient, Broker, RedisClient ];

  const queue = broker.getQueue()!;

  // Pending inserts grouped by collection name.
  const batchStore: Record<string, PendingEntry[]> = {};

  // Drain all pending batches to MongoDB.
  const flush = async (): Promise<void> => {
    const collections = Object.keys(batchStore);

    await Promise.all(collections.map(async (collection) => {
      const entries = batchStore[collection]!.splice(0);

      if (entries.length === 0) return;

      await flushBatch(mongo, config.database, collection, entries);
    }));
  };

  const flushTimer = setInterval(flush, config.flushIntervalMs);

  progress.start(redis, config.progressIntervalMs);

  const stopConsuming = await queue.consume(async (message: unknown, { ack, nack, metadata }: ConsumerEvent) => {
    if (metadata.routingKey === 'control') {
      handleControl(message, service);
      return ack();
    }

    const table    = metadata.headers?.['x-table']     as string | undefined;
    const date     = metadata.headers?.['x-date']      as string | undefined;
    const msgIndex = metadata.headers?.['x-msg-index'] as number | undefined;

    if (! table || ! date || msgIndex === undefined) {
      service.logger.warn({ headers: metadata.headers }, 'Record missing required headers — discarding');
      return ack();
    }

    const doc   = message as Record<string, unknown>;
    const id    = makeId(date, msgIndex);
    const entry: PendingEntry = { _id: id, doc, table, date, msgIndex, ack, nack };

    if (! batchStore[table])
      batchStore[table] = [];

    batchStore[table]!.push(entry);

    service.emit('message');
  }, { prefetch: config.prefetch });

  service.on('shutdown', async () => {
    clearInterval(flushTimer);
    progress.stop();

    if (stopConsuming)
      await stopConsuming();

    await flush();
  });
});

/**
 * Validate a `control` routing-key payload and forward it to progress. Bad
 * payloads are logged and dropped — we always ack to keep the queue moving.
 */
const handleControl = (message: unknown, service: Service): void => {
  if (! isControlMessage(message)) {
    service.logger.warn({ message }, 'Malformed control message — discarding');
    return;
  }

  progress.recordControl(message);
};

const isControlMessage = (m: unknown): m is ControlMessage =>
  typeof m === 'object' &&
  m !== null &&
  (m as ControlMessage).type === 'complete' &&
  typeof (m as ControlMessage).table === 'string' &&
  typeof (m as ControlMessage).date === 'string' &&
  typeof (m as ControlMessage).highestIndex === 'number';
