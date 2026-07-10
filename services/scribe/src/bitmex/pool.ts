/**
 * The shared worker pool — a fair (FIFO) cap on how many BitMEX page fetches may
 * run concurrently across *all* table loops at once.
 *
 * Each table streams its own pages through its own ordering ring, but every
 * dispatch first takes a slot here, so the total in flight never exceeds
 * MAX_IN_FLIGHT no matter how many tables are backfilling. That's what keeps the
 * shared rate-limit budget from being overshot: when each table had an independent
 * ring, N active tables meant N× the concurrency and the pacing couldn't react
 * before the burst drained the buckets, so two or three tables drove constant
 * 429s. One bounded pool fixes that.
 *
 * A lone table can take every slot (so it runs exactly as a single ring did);
 * with several active, a freed slot is handed to the longest-waiting requester, so
 * they share fairly. The ring size matches the pool size for that reason — one
 * table on its own saturates the pool.
 */

import config from '../config';

/** Max concurrent fetches across the whole service; also each table's ring size. Tunable via SCRIBE_IN_FLIGHT. */
export const MAX_IN_FLIGHT = config.inFlight;

let free = MAX_IN_FLIGHT;
const waiters: (() => void)[] = [];

/** Take a slot, waiting (FIFO) when the pool is fully in use. */
export const acquireSlot = (): Promise<void> => {
  if (free > 0) {
    free--;

    return Promise.resolve();
  }

  return new Promise<void>(resolve => { waiters.push(resolve); });
};

/** Return a slot — handed straight to the next waiter if there is one (so it stays fair). */
export const releaseSlot = (): void => {
  const next = waiters.shift();

  if (next) {
    next();

    return;
  }

  if (free < MAX_IN_FLIGHT) free++; // guard: an unpaired release must never inflate the pool past its size
};

// ── Test access ───────────────────────────────────────────────────────────────

/** Reset to a full pool between tests so a test's abandoned look-ahead can't bleed into the next. */
export const _test_resetPool = (): void => {
  free = MAX_IN_FLIGHT;
  waiters.length = 0;
};
