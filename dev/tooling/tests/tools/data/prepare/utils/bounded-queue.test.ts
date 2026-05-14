import { describe, it, expect } from 'vitest';
import { BoundedQueue } from '../../../../../src/tools/data/prepare/utils/bounded-queue';

describe('BoundedQueue', () => {
  it('passes single items through when below capacity', async () => {
    const q = new BoundedQueue<number>(10);

    await q.push(1);
    await q.push(2);
    q.close();

    expect(await q.take()).toBe(1);
    expect(await q.take()).toBe(2);
    expect(await q.take()).toBeNull();
  });

  it('blocks the producer when at capacity', async () => {
    const q = new BoundedQueue<number>(2);

    await q.push(1);
    await q.push(2);

    let pushResolved = false;
    const pushPromise = q.push(3).then(() => { pushResolved = true; });

    // Yield once — push should still be blocked.
    await new Promise(r => setImmediate(r));
    expect(pushResolved).toBe(false);

    expect(await q.take()).toBe(1);

    await pushPromise;
    expect(pushResolved).toBe(true);

    expect(await q.take()).toBe(2);
    expect(await q.take()).toBe(3);
  });

  it('blocks the consumer when empty until close()', async () => {
    const q = new BoundedQueue<number>(10);

    let result: number | null | 'pending' = 'pending';
    const takePromise = q.take().then(v => { result = v; });

    await new Promise(r => setImmediate(r));
    expect(result).toBe('pending');

    q.close();
    await takePromise;

    expect(result).toBeNull();
  });

  it('respects sizeOf for capacity tracking', async () => {
    const q = new BoundedQueue<number[]>(5, arr => arr.length);

    await q.push([1, 1, 1]); // size 3
    await q.push([2, 2]);    // size 5 — at capacity

    let pushResolved = false;
    const pushPromise = q.push([3]).then(() => { pushResolved = true; });

    await new Promise(r => setImmediate(r));
    expect(pushResolved).toBe(false);

    await q.take(); // drops size to 2

    await pushPromise;
    expect(pushResolved).toBe(true);
  });

  it('fail() causes subsequent take() to throw', async () => {
    const q = new BoundedQueue<number>(10);

    q.fail(new Error('boom'));

    await expect(q.take()).rejects.toThrow('boom');
  });

  it('fail() wakes a pending take() with the error', async () => {
    const q = new BoundedQueue<number>(10);

    const takePromise = q.take();

    q.fail(new Error('boom'));

    await expect(takePromise).rejects.toThrow('boom');
  });
});
