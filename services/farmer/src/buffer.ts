/**
 * Single-producer / single-consumer bounded async buffer with high/low water
 * mark backpressure.
 *
 *   - `push(item)` blocks when the buffered total >= `highWater`; resumes once
 *     a `pop` drains it down to `lowWater` (hysteresis prevents thrashing).
 *   - `pop(max)` blocks while the buffer is empty but open. Resolves with up
 *     to `max` items as one batch, or with `undefined` once `close()` is
 *     called and the buffer has been drained. Batched popping avoids the
 *     O(N) `Array.shift` cost on every item.
 *
 * The "total" the watermarks bound is `sum(sizeOf(item))`. With the default
 * `sizeOf` (`() => 1`) that's the item count; pass `sizeOf: i => i.size` to
 * bound by bytes instead, so the memory ceiling stops depending on how big
 * each item happens to be. `pop(max)` always counts items, not the total —
 * `max` caps how many items come back in one batch regardless of mode.
 *
 * Optional `onPause` / `onResume` callbacks let an outside observer (metrics,
 * logging) react to backpressure transitions without polling.
 *
 * The implementation is JS-single-threaded — no locks needed.
 */

import type { BoundedBuffer, BoundedBufferOpts } from './types';

export const createBoundedBuffer = <T>(opts: BoundedBufferOpts<T>): BoundedBuffer<T> => {
  const { highWater, lowWater, onPause, onResume } = opts;
  const sizeOf = opts.sizeOf ?? ((): number => 1);

  if (lowWater > highWater) {
    throw new Error(`lowWater (${lowWater}) must not exceed highWater (${highWater})`);
  }

  const items: T[] = [];
  /** Sum of `sizeOf(item)` across buffered items — what the watermarks bound. */
  let total        = 0;
  let closed       = false;
  let paused       = false;

  let pushWaiters: Array<() => void> = [];
  let popWaiters:  Array<() => void> = [];

  const wakePushers = (): void => {
    if (total > lowWater || pushWaiters.length === 0) return;

    if (paused) {
      paused = false;
      onResume?.();
    }

    const waiters = pushWaiters;

    pushWaiters = [];
    waiters.forEach(r => r());
  };

  const wakePoppers = (): void => {
    if (popWaiters.length === 0) return;

    const waiters = popWaiters;

    popWaiters = [];
    waiters.forEach(r => r());
  };

  return {
    push: async (item: T): Promise<void> => {
      if (closed) throw new Error('push to closed buffer');

      while (total >= highWater) {
        if (! paused) {
          paused = true;
          onPause?.();
        }

        await new Promise<void>(resolve => pushWaiters.push(resolve));
      }

      items.push(item);
      total += sizeOf(item);
      wakePoppers();
    },

    pop: async (max: number): Promise<T[] | undefined> => {
      while (items.length === 0 && ! closed) {
        await new Promise<void>(resolve => popWaiters.push(resolve));
      }

      if (items.length === 0) return undefined;

      const batch = items.splice(0, max);

      for (const item of batch) total -= sizeOf(item);

      wakePushers();

      return batch;
    },

    close: (): void => {
      closed = true;
      wakePoppers();
    },

    size: (): number => items.length,
  };
};
