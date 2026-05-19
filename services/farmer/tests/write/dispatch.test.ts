import { describe, it, expect } from 'vitest';
import { startDispatch, type TableBatches } from '../../src/write/dispatch';
import { createBoundedBuffer } from '../../src/buffer';
import { Task } from '../../src/orchestration';
import type { Item } from '../../src/types';
import type { BitmexTable } from '@tradebot/types';

const makeTask = (table: BitmexTable): Task => new Task({
  table, date: '20240315',
  skip:       0,
  intervalMs: 60_000,
  stopSignal: { triggered: false },
});

const itemFor = (task: Task, position: number): Item => ({ task, position, parsed: { foo: 1 } });

// ── Routes by item.task.table ─────────────────────────────────────────────────

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

    expect(batches.get('trade')!.map(i => i.position)).toEqual([1, 2]);
    expect(batches.get('orderBookL2')!.map(i => i.position)).toEqual([1, 2]);

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
