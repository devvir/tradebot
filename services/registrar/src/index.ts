import type { MongoClient } from 'mongodb';
import { type Service } from '@devvir/service-kit';
import SK from './service';
import { makeId } from './id';
import { flushBatch } from './insert';
import type { Broker, ConsumerEvent, Config, PendingEntry } from './types';

SK.run(async (service: Service) => {
  const config = service.config() as Config;

  const [ mongo, broker ] = await service.providers.connect([
    'mongodb',
    'rabbitmq',
  ]) as [ MongoClient, Broker ];

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

  const stopConsuming = await queue.consume(async (message: unknown, { ack, nack, metadata }: ConsumerEvent) => {
    const table    = metadata.headers?.['x-table']     as string | undefined;
    const date     = metadata.headers?.['x-date']      as string | undefined;
    const msgIndex = metadata.headers?.['x-msg-index'] as number | undefined;

    if (! table || ! date || msgIndex === undefined) {
      service.logger.warn({ headers: metadata.headers }, 'Record missing required headers — discarding');
      return ack();
    }

    const doc  = message as Record<string, unknown>;
    const id   = makeId(date, msgIndex);
    const entry: PendingEntry = { _id: id, doc, ack, nack };

    if (! batchStore[table])
      batchStore[table] = [];

    batchStore[table]!.push(entry);

    service.emit('message');
  }, { prefetch: config.prefetch });

  service.on('shutdown', async () => {
    clearInterval(flushTimer);

    if (stopConsuming)
      await stopConsuming();

    await flush();
  });
});
