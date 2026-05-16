/**
 * Single-producer / single-consumer bounded async buffer with high/low water
 * mark backpressure.
 *
 *   - `push(item)` blocks when size >= `highWater`; resumes once a `pop`
 *     drains the buffer down to `lowWater` (hysteresis prevents thrashing
 *     between producer and consumer on every item).
 *   - `pop()` blocks when the buffer is empty; resolves with the next item
 *     as soon as one is pushed, or with `undefined` once the buffer has been
 *     `close()`d and drained.
 *
 * The implementation is JS-single-threaded — no locks needed.
 */

import type { BoundedBuffer } from './types';

export const createBoundedBuffer = <T>(highWater: number, lowWater: number): BoundedBuffer<T> => {
  if (lowWater > highWater) {
    throw new Error(`lowWater (${lowWater}) must not exceed highWater (${highWater})`);
  }

  const items: T[] = [];
  let closed       = false;

  let pushWaiters: Array<() => void> = [];
  let popWaiters:  Array<() => void> = [];

  const wakePushers = (): void => {
    if (items.length > lowWater || pushWaiters.length === 0) return;

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
        await new Promise<void>(resolve => pushWaiters.push(resolve));
      }

      items.push(item);
      wakePoppers();
    },

    pop: async (): Promise<T | undefined> => {
      while (items.length === 0 && ! closed) {
        await new Promise<void>(resolve => popWaiters.push(resolve));
      }

      if (items.length === 0) return undefined;

      const item = items.shift()!;

      wakePushers();

      return item;
    },

    close: (): void => {
      closed = true;
      wakePoppers();
    },

    size: (): number => items.length,
  };
};
