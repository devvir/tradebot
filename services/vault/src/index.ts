import SK from '@devvir/service-kit';
import type { Service } from '@devvir/service-kit';
import { logger } from '@devvir/service-kit';
import { createServer } from './server';
import { startTicker, stopTicker } from './data/ticker';
import { buffers } from './data/buffers';
import { TABLE_HEADERS } from './data/headers';
import { appendBatch, isInitialized, drainHandle } from './fs/writer';

SK.run((service: Service) => {
  createServer(service);
  startTicker();

  service.on('shutdown', async () => {
    stopTicker();

    const remaining = buffers.flushAll();

    // Append every drained buffer (no seal — sealing is client-driven, not a
    // shutdown concern). After scheduling, await each handle's write chain so
    // we know the bytes are on disk before the process exits.
    for (const { table, filename, lines } of remaining) {
      const finalLines = isInitialized(table, filename)
        ? lines
        : [TABLE_HEADERS[table]!.join(','), ...lines];

      appendBatch(table, filename, finalLines).catch((err) => {
        logger.error({ err, table, filename }, 'Final flush at shutdown failed');
      });
    }

    await Promise.all(remaining.map(({ table, filename }) => drainHandle(table, filename)));

    logger.info('Vault shutdown drain complete');
  });
});
