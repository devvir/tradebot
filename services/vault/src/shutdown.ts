// Ordered graceful shutdown.
//
// `shutdownVault` runs the whole sequence itself, one step after the other:
//
//   1. Refuse writes: from here on the write routes answer 503.
//   2. Close the HTTP server: wait for in-flight requests (bounded by the
//      server's close deadline), so every row acknowledged with 202 is in a
//      buffer before the next step.
//   3. Stop the ticker and write every non-empty buffer to its file.
//   4. Wait for every writer's queued members and every seal in progress.
//
// Writing a buffer never seals it; a bucket left open is resumed on the next
// start.

import { logger } from '@devvir/service-kit';
import { stopTicker } from './data/ticker';
import { buffers } from './data/buffers';
import { writeLines } from './data/bucket';
import { drainAll } from './fs/writer';

/** The HTTP side of shutdown: resolves once the server has stopped. */
export interface HttpCloser {
  close(): Promise<void>;
}

let shuttingDown = false;

/** True once shutdown has started; write routes refuse requests from then on. */
export const isShuttingDown = (): boolean => shuttingDown;

export const shutdownVault = async (http: HttpCloser): Promise<void> => {
  shuttingDown = true;

  logger.info('Shutdown initiated — closing HTTP server');

  try {
    await http.close();

    logger.info('Vault HTTP server closed');
  } catch (err) {
    logger.error({ err }, 'HTTP server close failed; draining anyway');
  }

  stopTicker();

  const writes = buffers.flushAll().map(({ table, filename, lines }) =>
    writeLines(table, filename, lines).catch((err) => {
      logger.error({ err, table, filename, rowsDropped: lines.length }, 'Final flush at shutdown failed');
    }),
  );

  await Promise.all(writes);
  await drainAll();

  logger.info('Vault shutdown drain complete');
};

// ── Test helpers ──────────────────────────────────────────────────────────────

export const _test_reset = (): void => { shuttingDown = false; };
