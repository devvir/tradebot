/**
 * Single-producer / single-consumer bounded async buffer with high/low water
 * mark backpressure.
 *
 *   - `push(item)` blocks when size >= `highWater`; resumes once a `pop`
 *     drains the buffer down to `lowWater` (hysteresis prevents thrashing).
 *   - `pop(max)` blocks while the buffer is empty but open. Resolves with up
 *     to `max` items as one batch, or with `undefined` once `close()` is
 *     called and the buffer has been drained. Batched popping avoids the
 *     O(N) `Array.shift` cost on every item.
 *
 * Optional `onPause` / `onResume` callbacks let an outside observer (metrics,
 * logging) react to backpressure transitions without polling `size()`.
 *
 * The implementation is JS-single-threaded — no locks needed.
 */

import type { BoundedBuffer, BoundedBufferOpts } from './types';

export const createBoundedBuffer = <T>(opts: BoundedBufferOpts): BoundedBuffer<T> => {
  const { highWater, lowWater, onPause, onResume } = opts;

  if (lowWater > highWater) {
    throw new Error(`lowWater (${lowWater}) must not exceed highWater (${highWater})`);
  }

  const items: T[] = [];
  let closed       = false;
  let paused       = false;

  let pushWaiters: Array<() => void> = [];
  let popWaiters:  Array<() => void> = [];

  const wakePushers = (): void => {
    if (items.length > lowWater || pushWaiters.length === 0) return;

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

      while (items.length >= highWater) {
        if (! paused) {
          paused = true;
          onPause?.();
        }

        await new Promise<void>(resolve => pushWaiters.push(resolve));
      }

      items.push(item);
      wakePoppers();
    },

    pop: async (max: number): Promise<T[] | undefined> => {
      while (items.length === 0 && ! closed) {
        await new Promise<void>(resolve => popWaiters.push(resolve));
      }

      if (items.length === 0) return undefined;

      const batch = items.splice(0, max);

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
