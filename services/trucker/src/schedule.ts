import { logger } from '@devvir/service-kit';

/**
 * Run a job on an interval, never letting two runs overlap.
 *
 * A full backfill runs far longer than the rescan interval, so a plain
 * `setInterval` would stack sweeps on top of each other — several passes
 * re-listing the same symbols and advancing the same cursors at once. A tick
 * that lands while a run is in flight is skipped rather than queued: the
 * running sweep already picks up anything newly published when it reaches that
 * symbol, and the next tick after it finishes catches the rest.
 *
 * This is the only thing standing between one sweep and several sharing a
 * cursor, which is why it lives in its own unit rather than inline in the
 * service entry point where it cannot be tested.
 *
 * A rejecting job is caught and logged rather than left to float. An unhandled
 * rejection here would take the process down under Node's default policy — and
 * a rescan that dies on one bad pass stops the service keeping up with new data
 * for good, which is the opposite of what the interval is for.
 */
export const everyNonOverlapping = (
  intervalMs: number,
  job:        () => Promise<void>,
): NodeJS.Timeout => {
  let running = false;

  return setInterval(() => {
    if (running) {
      logger.info('Sweep still running — skipping this rescan');

      return;
    }

    logger.info('Rescanning for newly published archives');

    running = true;

    void job()
      .catch(err => logger.error({ err }, 'Scheduled sweep failed'))
      .finally(() => { running = false; });
  }, intervalMs);
};
