import { describe, it, expect, vi } from 'vitest';
import { createBoundedBuffer } from '../src/buffer';

const flush = () => new Promise<void>(r => setImmediate(r));

// ── Construction ──────────────────────────────────────────────────────────────

describe('createBoundedBuffer — construction', () => {
  it('rejects lowWater > highWater', () => {
    expect(() => createBoundedBuffer({ highWater: 5, lowWater: 10 })).toThrow();
  });
});

// ── FIFO order ────────────────────────────────────────────────────────────────

describe('createBoundedBuffer — FIFO', () => {
  it('pop returns items in push order as one batch', async () => {
    const buf = createBoundedBuffer<number>({ highWater: 10, lowWater: 5 });

    await buf.push(1);
    await buf.push(2);
    await buf.push(3);

    expect(await buf.pop(10)).toEqual([1, 2, 3]);
  });

  it('pop respects max and leaves the rest', async () => {
    const buf = createBoundedBuffer<number>({ highWater: 10, lowWater: 5 });

    await buf.push(1);
    await buf.push(2);
    await buf.push(3);

    expect(await buf.pop(2)).toEqual([1, 2]);
    expect(await buf.pop(10)).toEqual([3]);
  });
});

// ── pop blocks while empty ────────────────────────────────────────────────────

describe('createBoundedBuffer — pop blocks while empty and open', () => {
  it('resolves once an item is pushed', async () => {
    const buf = createBoundedBuffer<string>({ highWater: 10, lowWater: 5 });

    const popped = buf.pop(10);
    let settled  = false;

    void popped.then(() => { settled = true; });

    await flush();
    expect(settled).toBe(false);

    await buf.push('hello');

    expect(await popped).toEqual(['hello']);
  });
});

// ── close drains then returns undefined ───────────────────────────────────────

describe('createBoundedBuffer — close', () => {
  it('pop returns undefined when closed and empty', async () => {
    const buf = createBoundedBuffer<number>({ highWater: 10, lowWater: 5 });

    buf.close();

    expect(await buf.pop(10)).toBeUndefined();
  });

  it('pop drains remaining items before returning undefined', async () => {
    const buf = createBoundedBuffer<number>({ highWater: 10, lowWater: 5 });

    await buf.push(1);
    await buf.push(2);

    buf.close();

    expect(await buf.pop(10)).toEqual([1, 2]);
    expect(await buf.pop(10)).toBeUndefined();
  });

  it('a blocked pop wakes with undefined when close is called', async () => {
    const buf = createBoundedBuffer<number>({ highWater: 10, lowWater: 5 });

    const popped = buf.pop(10);

    buf.close();

    expect(await popped).toBeUndefined();
  });

  it('push to closed buffer rejects', async () => {
    const buf = createBoundedBuffer<number>({ highWater: 10, lowWater: 5 });

    buf.close();

    await expect(buf.push(1)).rejects.toThrow();
  });
});

// ── Backpressure (high/low watermark) ─────────────────────────────────────────

describe('createBoundedBuffer — high/low watermark backpressure', () => {
  it('push blocks once highWater is reached', async () => {
    const buf = createBoundedBuffer<number>({ highWater: 3, lowWater: 1 });

    await buf.push(1);
    await buf.push(2);
    await buf.push(3);

    let settled = false;

    void buf.push(4).then(() => { settled = true; });

    await flush();
    expect(settled).toBe(false);
    expect(buf.size()).toBe(3);
  });

  it('blocked push resumes when size drops to lowWater', async () => {
    const buf = createBoundedBuffer<number>({ highWater: 3, lowWater: 1 });

    await buf.push(1);
    await buf.push(2);
    await buf.push(3);

    const pending = buf.push(4);

    /** Drain to size=1 (= lowWater), which should release the waiter. */
    await buf.pop(2);

    await pending;
    expect(buf.size()).toBe(2); /** 3 left after pops, then push(4) added one. */
  });
});

// ── onPause / onResume callbacks ──────────────────────────────────────────────

describe('createBoundedBuffer — onPause / onResume callbacks', () => {
  it('onPause fires the first time push blocks at highWater', async () => {
    const onPause  = vi.fn();
    const onResume = vi.fn();
    const buf     = createBoundedBuffer<number>({ highWater: 2, lowWater: 1, onPause, onResume });

    await buf.push(1);
    await buf.push(2);

    expect(onPause).not.toHaveBeenCalled();

    void buf.push(3);
    await flush();

    expect(onPause).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
  });

  it('onResume fires when the buffer drains to lowWater after a pause', async () => {
    const onPause  = vi.fn();
    const onResume = vi.fn();
    const buf     = createBoundedBuffer<number>({ highWater: 2, lowWater: 1, onPause, onResume });

    await buf.push(1);
    await buf.push(2);

    void buf.push(3);
    await flush();

    expect(onPause).toHaveBeenCalledTimes(1);

    await buf.pop(1);

    /** Drained from 2 → 1 (= lowWater), so the pause is released. */
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('onPause fires only once per pause/resume cycle even if multiple waiters queue', async () => {
    const onPause = vi.fn();
    const buf     = createBoundedBuffer<number>({ highWater: 2, lowWater: 1, onPause });

    await buf.push(1);
    await buf.push(2);

    void buf.push(3);
    void buf.push(4);
    void buf.push(5);
    await flush();

    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('onPause/onResume not called if neither configured and buffer fills/drains', async () => {
    /** Just verifies the buffer doesn't blow up without callbacks. */
    const buf = createBoundedBuffer<number>({ highWater: 2, lowWater: 1 });

    await buf.push(1);
    await buf.push(2);

    void buf.push(3);
    await flush();
    await buf.pop(1);
    await flush();

    expect(buf.size()).toBe(2);
  });
});
