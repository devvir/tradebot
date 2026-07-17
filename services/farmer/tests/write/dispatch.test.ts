import { describe, it, expect } from 'vitest';
import { startDispatch } from '../../src/write/dispatch';
import { createBoundedBuffer } from '../../src/buffer';
import { Task } from '../../src/orchestration';
import type { Item, TableBatches } from '../../src/types';
import type { BitmexTable } from '@tradebot/types';

const makeTask = (table: BitmexTable): Task => new Task({
  table, date: '20240315',
  skip:       0,
  intervalMs: 60_000,
  stopSignal: { triggered: false },
});

const itemFor = (task: Task, position: number, secondary: boolean = false): Item =>
  ({ task, position, content: '{"foo":1}', size: 9, secondary });

// ── Routes by routing identity (base table + target db) ──────────────────────

describe('startDispatch', () => {
  it('routes each item into its task table batch in order', async () => {
    const writerQueue = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });
    const batches: TableBatches = new Map();

    const loop = startDispatch(writerQueue, batches);

    const trade = makeTask('trade');
    const ob    = makeTask('orderBookL2');

    await writerQueue.push(itemFor(trade, 1));
    await writerQueue.push(itemFor(ob,    1));
    await writerQueue.push(itemFor(trade, 2));
    await writerQueue.push(itemFor(ob,    2));

    await new Promise(r => setImmediate(r));

    expect(batches.get('trade')!.items.map(i => i.position)).toEqual([1, 2]);
    expect(batches.get('orderBookL2')!.items.map(i => i.position)).toEqual([1, 2]);

    writerQueue.close();
    await loop;
  });

  it('splits secondary items into their own batch for the same table', async () => {
    const writerQueue = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });
    const batches: TableBatches = new Map();

    const loop = startDispatch(writerQueue, batches);

    const trade = makeTask('trade');

    await writerQueue.push(itemFor(trade, 1));
    await writerQueue.push(itemFor(trade, 2, true));
    await writerQueue.push(itemFor(trade, 3));

    await new Promise(r => setImmediate(r));

    expect(batches.get('trade')!.items.map(i => i.position)).toEqual([1, 3]);
    expect(batches.get('trade')!.secondary).toBe(false);
    expect(batches.get('trade:p2')!.items.map(i => i.position)).toEqual([2]);
    expect(batches.get('trade:p2')!.secondary).toBe(true);
    expect(batches.get('trade:p2')!.table).toBe('trade');

    writerQueue.close();
    await loop;
  });

  it('merges qualified-bucket items with same-pool items of the base table', async () => {
    const writerQueue = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });
    const batches: TableBatches = new Map();

    const loop = startDispatch(writerQueue, batches);

    /** A secondary item from the base bucket and one from the qualified bucket
     *  share the same routing identity → one batch, one collection, one db. */
    const base      = makeTask('orderBookL2');
    const qualified = makeTask('orderBookL2.secondary' as BitmexTable);

    await writerQueue.push(itemFor(base,      1, true));
    await writerQueue.push(itemFor(qualified, 1, true));

    await new Promise(r => setImmediate(r));

    expect(batches.size).toBe(1);
    expect(batches.get('orderBookL2:p2')!.items).toHaveLength(2);
    expect(batches.get('orderBookL2:p2')!.table).toBe('orderBookL2');

    writerQueue.close();
    await loop;
  });

  it('exits cleanly when the writer queue is closed', async () => {
    const writerQueue = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });
    const batches: TableBatches = new Map();

    const loop = startDispatch(writerQueue, batches);

    writerQueue.close();
    await expect(loop).resolves.toBeUndefined();
  });
});
