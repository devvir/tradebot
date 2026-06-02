import { logger, type Service } from '@devvir/service-kit';
import SK from './service';
import { createBoundedBuffer } from './buffer';
import { logMetrics, recordReadPause, recordReadResume, setReaderQueueProbe, startMetricsAdvance, stopMetricsAdvance } from './metrics';
import { startInfer } from './process/infer';
import { startAssemble } from './process/assemble';
import { startDispatch, type TableBatches } from './write/dispatch';
import { startFlush, MAX_BYTES_PER_REQUEST } from './write/flush';
import { initStaging } from './write/staging';
import { runWorkers } from './loop';
import type { Config, Item } from './types';

/** Read-ahead: stage two full send-sets behind what's in flight, hard-capped
 *  so a large `FARMER_INFLIGHT_CAP` can't blow the read buffers past 1 GiB. */
const READ_AHEAD_FACTOR    = 2;
const READ_BUFFER_HARD_CAP = 1024 ** 3;
/** How often the throughput summary line is logged. */
const METRICS_INTERVAL_MS  = 60_000;

SK.run(async (service: Service) => {
  const config = service.config() as Config;

  /** mongo is still required because the forensics path (`write/errors.ts`)
   *  writes parse-failure raw lines to `farmer.<table>` directly via the
   *  service registry. The main flush path goes through the writer service. */
  await service.providers.connect([ 'mongodb', 'redis' ]);

  /**
   * Everything downstream sizes off the one knob. Staging holds a full
   * send-set (`inflightCap` requests × the per-request ceiling) ready to go;
   * the read buffers hold a couple of send-sets of read-ahead, hard-capped.
   * All byte-based, so the footprint is flat regardless of message size.
   */
  const stagingBytes    = config.inflightCap * MAX_BYTES_PER_REQUEST;
  const readBufferBytes = Math.min(READ_AHEAD_FACTOR * stagingBytes, READ_BUFFER_HARD_CAP);

  logger.info({ inflightCap: config.inflightCap, maxBytesPerRequest: MAX_BYTES_PER_REQUEST, stagingBytes, readBufferBytes }, 'Buffer byte ceilings');

  initStaging(stagingBytes);

  const readerQueue = createBoundedBuffer<Item>({
    highWater: readBufferBytes,
    lowWater:  Math.floor(readBufferBytes / 2),
    sizeOf:    item => item.size,
    onPause:   recordReadPause,
    onResume:  recordReadResume,
  });

  setReaderQueueProbe(readerQueue.size);

  const assemblerQueue = createBoundedBuffer<Item>({
    highWater: readBufferBytes,
    lowWater:  Math.floor(readBufferBytes / 2),
    sizeOf:    item => item.size,
  });

  const writerQueue = createBoundedBuffer<Item>({
    highWater: stagingBytes,
    lowWater:  Math.floor(stagingBytes / 2),
    sizeOf:    item => item.size,
  });

  const batches: TableBatches = new Map();

  // Pipeline stages run as background loops; they exit when their queue is closed.
  void startInfer(readerQueue, assemblerQueue, writerQueue);
  void startAssemble(assemblerQueue, writerQueue);
  void startDispatch(writerQueue, batches);

  const flushTimer   = startFlush(config.librarianUrl, batches, config.flushIntervalMs, config.inflightCap);
  const metricsTimer = setInterval(logMetrics, METRICS_INTERVAL_MS);

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
