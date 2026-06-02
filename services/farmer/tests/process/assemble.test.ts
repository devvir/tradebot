import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registry } from '@devvir/service-kit';
import {
  startAssemble,
  _test_EMPTY_DATA_SUFFIX        as EMPTY_DATA_SUFFIX,
  _test_extractAction            as extractAction,
  _test_extractDate              as extractDate,
  _test_extractDataSlice         as extractDataSlice,
  _test_extractFirstRowTimestamp as extractFirstRowTimestamp,
} from '../../src/process/assemble';
import { createBoundedBuffer } from '../../src/buffer';
import { Task } from '../../src/orchestration';
import { initStaging, _test_reset as resetStaging, stagedBytes } from '../../src/write/staging';
import type { Item } from '../../src/types';
import type { BitmexTable } from '@tradebot/types';
import type { Service } from '@devvir/service-kit';
import type { MongoClient } from 'mongodb';

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeService = (): Service & { shutdown: ReturnType<typeof vi.fn> } => {
  const ee = new EventEmitter() as unknown as Service & { shutdown: ReturnType<typeof vi.fn> };

  ee.shutdown = vi.fn().mockResolvedValue(undefined);

  return ee;
};

const makeTask = (table: BitmexTable, date: string = '20240315'): Task => new Task({
  table, date,
  skip:       0,
  intervalMs: 60_000,
  stopSignal: { triggered: false },
});

const wsItem = (task: Task, position: number, payload: unknown): Item => {
  const content = JSON.stringify(payload);

  return { task, position, content, size: content.length };
};

const rawItem = (task: Task, position: number, content: string): Item => ({
  task,
  position,
  content,
  size: content.length,
});

const makeMongoForErrors = () => {
  const insertOne  = vi.fn().mockResolvedValue({});
  const collection = vi.fn(() => ({ insertOne }));
  const db         = vi.fn(() => ({ collection }));

  return {
    mongo:      { db } as unknown as MongoClient,
    insertOne,
    collection,
  };
};

const setupRegistry = (mongo: MongoClient, service: Service & { shutdown: () => Promise<void> }): void => {
  vi.mocked(registry.get).mockReturnValue({
    providers: { get: vi.fn(() => mongo) },
    shutdown:  service.shutdown,
  } as never);
};

beforeEach(() => {
  resetStaging();
  initStaging(100_000);
  vi.mocked(registry.get).mockReset();
});

// ── Helpers — pure functions ──────────────────────────────────────────────────

describe('EMPTY_DATA_SUFFIX', () => {
  it('matches vault envelopes with an empty data array', () => {
    expect('{"action":"insert","date":"x","data":[]}'.endsWith(EMPTY_DATA_SUFFIX)).toBe(true);
  });

  it('does not match envelopes with non-empty data arrays', () => {
    expect('{"action":"insert","date":"x","data":[{"a":1}]}'.endsWith(EMPTY_DATA_SUFFIX)).toBe(false);
  });
});

describe('extractAction', () => {
  it('returns the action string', () => {
    expect(extractAction('{"action":"insert","date":"x","data":[]}')).toBe('insert');
    expect(extractAction('{"action":"partial:XBTUSD","date":"x","data":[]}')).toBe('partial:XBTUSD');
  });

  it('returns null when no action field is found', () => {
    expect(extractAction('{"foo":"bar"}')).toBeNull();
    expect(extractAction('')).toBeNull();
  });
});

describe('extractDate', () => {
  it('returns the date string', () => {
    expect(extractDate('{"action":"insert","date":"2024-06-15T12:34:56.789Z","data":[]}'))
      .toBe('2024-06-15T12:34:56.789Z');
  });

  it('returns null when no date field is found', () => {
    expect(extractDate('{"action":"insert","data":[]}')).toBeNull();
  });
});

describe('extractDataSlice', () => {
  it('returns the slice between [ and ]', () => {
    expect(extractDataSlice('{"action":"insert","date":"x","data":[{"a":1},{"b":2}]}')).toBe('{"a":1},{"b":2}');
  });

  it('returns empty string for empty data arrays', () => {
    expect(extractDataSlice('{"action":"insert","date":"x","data":[]}')).toBe('');
  });

  it('returns null when no data field is found', () => {
    expect(extractDataSlice('{"action":"insert","date":"x"}')).toBeNull();
  });
});

describe('extractFirstRowTimestamp', () => {
  it('returns the first row timestamp', () => {
    expect(extractFirstRowTimestamp('{"symbol":"X","timestamp":"2024-06-15T12:34:56.789Z","price":1},{"timestamp":"later"}'))
      .toBe('2024-06-15T12:34:56.789Z');
  });

  it('returns null when no timestamp is present', () => {
    expect(extractFirstRowTimestamp('{"symbol":"X","price":1}')).toBeNull();
  });
});

// ── Success path — string template ────────────────────────────────────────────

describe('startAssemble — common string path', () => {
  it('mutates content into the wire envelope and pushes to writer queue', async () => {
    const task = makeTask('orderBookL2');
    const inQ  = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });
    const outQ = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });

    setupRegistry(makeMongoForErrors().mongo, makeService());

    const loop = startAssemble(inQ, outQ);

    await inQ.push(wsItem(task, 1, {
      action: 'insert',
      date:   '2024-06-15T12:34:56.789Z',
      data:   [
        { symbol: 'XBTUSD', id: 1, side: 'Buy', size: 100, price: 29_500, timestamp: '2024-06-15T12:34:00.000Z' },
        { symbol: 'XBTUSD', id: 2, side: 'Sell', size: 50,  price: 29_510, timestamp: '2024-06-15T12:34:05.000Z' },
      ],
    }));

    const batch = await outQ.pop(10);

    expect(batch).toBeDefined();
    expect(batch!).toHaveLength(1);

    const item = batch![0]!;

    expect(item.content.startsWith('{"table":"orderBookL2","action":"insert","data":[')).toBe(true);
    expect(item.content.endsWith('}')).toBe(true);
    expect(item.content).toContain('"timestamp":"2024-06-15T12:34:00.000Z"'); /** first row's ts */
    expect(item.size).toBe(item.content.length);
    expect(stagedBytes()).toBe(item.size);

    inQ.close();
    await loop;
  });

  it('uses envelope date as timestamp for tables outside the timestamp lookup set', async () => {
    const task = makeTask('publicNotifications');
    const inQ  = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });
    const outQ = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });

    setupRegistry(makeMongoForErrors().mongo, makeService());

    const loop = startAssemble(inQ, outQ);

    await inQ.push(wsItem(task, 1, {
      action: 'insert',
      date:   '2024-06-15T12:34:56.789Z',
      data:   [{ id: 1, message: 'a "timestamp" mention in free text' }],
    }));

    const batch = await outQ.pop(10);
    const item  = batch![0]!;

    /** Envelope date is used, never the in-row mention. */
    expect(item.content).toContain('"timestamp":"2024-06-15T12:34:56.789Z"');

    inQ.close();
    await loop;
  });

  it('decorates partial actions with types/filter/keys from TABLE_SPECS', async () => {
    const task = makeTask('orderBookL2');
    const inQ  = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });
    const outQ = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });

    setupRegistry(makeMongoForErrors().mongo, makeService());

    const loop = startAssemble(inQ, outQ);

    await inQ.push(wsItem(task, 1, {
      action: 'partial',
      date:   '2024-06-15T12:34:56.789Z',
      data:   [{ symbol: 'XBTUSD', id: 1, side: 'Buy', size: 100, price: 29_500, timestamp: '2024-06-15T12:34:00.000Z' }],
    }));

    const batch = await outQ.pop(10);
    const item  = batch![0]!;

    expect(item.content).toContain('"action":"partial"');
    expect(item.content).toContain('"types":');
    expect(item.content).toContain('"filter":');
    expect(item.content).toContain('"keys":');

    inQ.close();
    await loop;
  });
});

// ── Empty data drop ───────────────────────────────────────────────────────────

describe('startAssemble — empty data drop', () => {
  it('drops empty-data envelopes via brace-count, bumps task progress, no writer push', async () => {
    const task = makeTask('orderBookL2');
    const inQ  = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });
    const outQ = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });

    setupRegistry(makeMongoForErrors().mongo, makeService());

    const loop = startAssemble(inQ, outQ);

    /** Position 1 so the drop lands on the frontier — `messages` advances to 1. */
    await inQ.push(wsItem(task, 1, { action: 'update', date: 'x', data: [] }));

    await new Promise(r => setImmediate(r));

    expect(task.messages).toBe(1);
    expect(task.pending).toBe(0);
    expect(stagedBytes()).toBe(0);
    expect(outQ.size()).toBe(0);

    inQ.close();
    await loop;
  });
});

// ── Malformed content → forensics ─────────────────────────────────────────────

describe('startAssemble — malformed content', () => {
  it('routes to farmer.<table>, bumps progress, drops the item', async () => {
    const task = makeTask('orderBookL2');
    const inQ  = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });
    const outQ = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });

    const m = makeMongoForErrors();

    setupRegistry(m.mongo, makeService());

    const loop = startAssemble(inQ, outQ);

    /** Has braces (rows>0) but no recognizable action field — forensics path. */
    await inQ.push(rawItem(task, 1, '{"foo":"bar","data":[{"x":1}]}'));

    await new Promise(r => setImmediate(r));

    expect(m.insertOne).toHaveBeenCalledTimes(1);
    expect(m.collection).toHaveBeenCalledWith('orderBookL2');
    expect(task.messages).toBe(1);
    expect(outQ.size()).toBe(0);

    inQ.close();
    await loop;
  });
});

// ── Parse fallback — partial:<symbol> ─────────────────────────────────────────

describe('startAssemble — partial:<symbol> exception path', () => {
  it('falls through to parse → reconstruct → stringify', async () => {
    const task = makeTask('orderBookL2');
    const inQ  = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });
    const outQ = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });

    setupRegistry(makeMongoForErrors().mongo, makeService());

    const loop = startAssemble(inQ, outQ);

    await inQ.push(wsItem(task, 1, {
      action: 'partial:XBTUSD',
      date:   '2024-06-15T12:34:56.789Z',
      data:   [{ symbol: 'XBTUSD', id: 1, side: 'Buy', size: 100, price: 29_500, timestamp: '2024-06-15T12:34:00.000Z' }],
    }));

    const batch = await outQ.pop(10);
    const item  = batch![0]!;

    /** Parse path decodes the symbol qualifier — final envelope's action is plain
     *  `partial`, with the per-message symbol filter. */
    expect(item.content).toContain('"action":"partial"');
    expect(item.content).toContain('"filter":{"symbol":"XBTUSD"}');

    inQ.close();
    await loop;
  });
});

// ── Unknown table → shutdown ──────────────────────────────────────────────────

describe('startAssemble — unknown table triggers shutdown', () => {
  it('calls service.shutdown(reason) and exits the loop', async () => {
    const task = makeTask('made_up_table' as BitmexTable);
    const inQ  = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });
    const outQ = createBoundedBuffer<Item>({ highWater: 10, lowWater: 5 });

    const service = makeService();

    setupRegistry(makeMongoForErrors().mongo, service);

    const loop = startAssemble(inQ, outQ);

    await inQ.push(wsItem(task, 1, { action: 'insert', date: 'x', data: [{ a: 1 }] }));

    await loop;

    expect(service.shutdown).toHaveBeenCalled();
    expect(outQ.size()).toBe(0);
  });
});
