/**
 * Global in-flight cap. The single backpressure choke point between the
 * processing side (infer / assemble) and the writing side (dispatch /
 * flush).
 *
 *   - infer / assemble call `await admit(1)` *before* pushing into the
 *     writer queue. If `current + count > cap` the call awaits a release.
 *   - flush calls `release(batch.length)` after a successful `insertMany`.
 *
 * `current` therefore equals (writer queue size + sum of per-table batch
 * sizes), the only number we actually want to bound. Counting only the
 * writer queue would miss items that have moved into batches but haven't
 * hit mongo; counting per-table sizes alone would let the writer queue
 * grow unbounded when mongo blocks.
 */

let cap     = Number.POSITIVE_INFINITY;
let current = 0;

let waiters: Array<() => void> = [];

// ── Public API ────────────────────────────────────────────────────────────────

export const initInflight = (capacity: number): void => {
  cap = capacity;
};

export const admit = async (count: number = 1): Promise<void> => {
  while (current + count > cap) {
    await new Promise<void>(resolve => waiters.push(resolve));
  }

  current += count;
};

export const release = (count: number): void => {
  current -= count;

  if (current < 0) current = 0;

  if (waiters.length === 0) return;

  const w = waiters;

  waiters = [];
  w.forEach(r => r());
};

export const inflightSize = (): number => current;

// ── Test-only exports ─────────────────────────────────────────────────────────

export const _test_reset = (): void => {
  cap     = Number.POSITIVE_INFINITY;
  current = 0;
  waiters = [];
};
