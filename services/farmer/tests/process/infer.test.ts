import { describe, it, expect, beforeEach } from 'vitest';
import { startInfer } from '../../src/process/infer';
import { createBoundedBuffer } from '../../src/buffer';
import { Task } from '../../src/orchestration';
import { initStaging, stagedBytes, _test_reset as resetStaging } from '../../src/write/staging';
import type { Item } from '../../src/types';
import type { BitmexTable } from '@tradebot/types';

const makeTask = (table: BitmexTable): Task => new Task({
  table, date: '20240315',
  skip:       0,
  intervalMs: 60_000,
  stopSignal: { triggered: false },
});

const item = (task: Task, position: number): Item => ({ task, position, content: 'x', size: 1 });

/** Drain N items from the queue across however many batches `pop` returns. */
const drain = async <T>(q: ReturnType<typeof createBoundedBuffer<T>>, n: number): Promise<T[]> => {
  const out: T[] = [];

  while (out.length < n) {
    const batch = await q.pop(n - out.length);

    if (! batch) break;

    out.push(...batch);
  }

  return out;
};

beforeEach(() => {
  resetStaging();
  initStaging(100_000);
});

// ── REST items go straight to writer queue, gated by staging ──────────────────

describe('startInfer — REST items', () => {
  it('forwards REST items to the writer queue and admits them to the staging gate', async () => {
    const readerQ   = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });
    const assembleQ = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });
    const writerQ   = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });

    const loop = startInfer(readerQ, assembleQ, writerQ);

    const trade = makeTask('trade'); /** REST */

    await readerQ.push(item(trade, 1));
    await readerQ.push(item(trade, 2));

    const out = await drain(writerQ, 2);

    expect(out[0]).toMatchObject({ position: 1 });
    expect(out[1]).toMatchObject({ position: 2 });

    expect(stagedBytes()).toBe(2);
    expect(assembleQ.size()).toBe(0);

    readerQ.close();
    await loop;
  });
});

// ── WS items go to the assembler queue (no staging gate yet) ──────────────────

describe('startInfer — WS items', () => {
  it('forwards WS items to the assembler queue without admitting to staging', async () => {
    const readerQ   = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });
    const assembleQ = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });
    const writerQ   = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });

    const loop = startInfer(readerQ, assembleQ, writerQ);

    const ob = makeTask('orderBookL2');

    await readerQ.push(item(ob, 1));
    await readerQ.push(item(ob, 2));

    const out = await drain(assembleQ, 2);

    expect(out[0]).toMatchObject({ position: 1 });
    expect(out[1]).toMatchObject({ position: 2 });

    expect(stagedBytes()).toBe(0);
    expect(writerQ.size()).toBe(0);

    readerQ.close();
    await loop;
  });
});

// ── Mixed flow ────────────────────────────────────────────────────────────────

describe('startInfer — mixed routing', () => {
  it('routes a mix of REST and WS items correctly', async () => {
    const readerQ   = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });
    const assembleQ = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });
    const writerQ   = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });

    const loop = startInfer(readerQ, assembleQ, writerQ);

    const trade = makeTask('trade');
    const ob    = makeTask('orderBookL2');

    await readerQ.push(item(trade, 1));
    await readerQ.push(item(ob,    1));
    await readerQ.push(item(trade, 2));
    await readerQ.push(item(ob,    2));

    const writes  = await drain(writerQ,   2);
    const asmbls  = await drain(assembleQ, 2);

    expect(writes[0]).toMatchObject({ task: trade, position: 1 });
    expect(writes[1]).toMatchObject({ task: trade, position: 2 });
    expect(asmbls[0]).toMatchObject({ task: ob,    position: 1 });
    expect(asmbls[1]).toMatchObject({ task: ob,    position: 2 });

    expect(stagedBytes()).toBe(2);

    readerQ.close();
    await loop;
  });
});
