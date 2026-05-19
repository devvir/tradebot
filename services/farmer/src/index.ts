import { type Service } from '@devvir/service-kit';
import SK from './service';
import { createBoundedBuffer } from './buffer';
import { logMetrics, recordReadPause, recordReadResume, setReaderQueueProbe, startMetricsAdvance, stopMetricsAdvance } from './metrics';
import { startInfer } from './process/infer';
import { startAssemble } from './process/assemble';
import { startDispatch, type TableBatches } from './write/dispatch';
import { startFlush } from './write/flush';
import { initInflight } from './write/inflight';
import { runWorkers } from './loop';
import type { Config, Item } from './types';

SK.run(async (service: Service) => {
  const config = service.config() as Config;

  /** mongo is still required because the forensics path (`write/errors.ts`)
   *  writes parse-failure raw lines to `farmer.<table>` directly via the
   *  service registry. The main flush path goes through the writer service. */
  await service.providers.connect([ 'mongodb', 'redis' ]);

  initInflight(config.inflightCap);

  const readerQueue = createBoundedBuffer<Item>({
    highWater: config.readBufferHigh,
    lowWater:  config.readBufferLow,
    onPause:   recordReadPause,
    onResume:  recordReadResume,
  });

  setReaderQueueProbe(readerQueue.size);

  const assemblerQueue = createBoundedBuffer<Item>({
    highWater: config.readBufferHigh,
    lowWater:  config.readBufferLow,
  });

  const writerQueue = createBoundedBuffer<Item>({
    highWater: config.inflightCap,
    lowWater:  Math.floor(config.inflightCap / 2),
  });

  const batches: TableBatches = new Map();

  // Pipeline stages run as background loops; they exit when their queue is closed.
  void startInfer(readerQueue, assemblerQueue, writerQueue);
  void startAssemble(assemblerQueue, writerQueue);
  void startDispatch(writerQueue, batches);

  const flushTimer   = startFlush(config.writerUrl, batches, config.flushIntervalMs, config.wireBytesCap);
  const metricsTimer = setInterval(logMetrics, config.metricsIntervalMs);

  metricsTimer.unref();

  startMetricsAdvance();

  service.on('shutdown', () => {
    clearInterval(flushTimer);
    clearInterval(metricsTimer);
    stopMetricsAdvance();
    /**
     * Discard everything buffered for mongo. Anything not yet flushed will be
     * re-streamed and re-inserted on the next run (deterministic `_id` makes
     * that idempotent via `E11000`). Skipping the shutdown flush avoids the
     * occasional too-large-BSON when a table's queue is close to the cap.
     */
    batches.clear();
  });

  /**
   * Workers consume from `orchestration.nextTask()`. Orchestration owns the
   * shutdown signal — it returns `undefined` once shutdown fires, which makes
   * each worker exit cleanly. The shared `stopSignal` is also embedded on
   * every Task and consulted by the flusher to abandon retries.
   */
  await runWorkers(config, readerQueue);
});
