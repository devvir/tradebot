import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  startFlush,
  _test_buildBody             as buildBody,
  _test_RETRY_INITIAL_MS      as RETRY_INITIAL_MS,
  _test_MAX_BYTES_PER_REQUEST as MAX_BYTES_PER_REQUEST,
  _test_sliceCount            as sliceCount,
} from '../../src/write/flush';
import { Task, type StopSignal } from '../../src/orchestration';
import { makeMongoId } from '@tradebot/utils';
import { admit, initInflight, _test_reset as resetInflight } from '../../src/write/inflight';
import type { Item } from '../../src/types';
import type { TableBatches } from '../../src/write/dispatch';
import type { BitmexTable } from '@tradebot/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a fetch mock that delegates each call to `impl`. Returns the spy plus
 *  helpers to construct 200/error response shapes the writer would return. */
const mockFetch = (impl: (url: string, init: RequestInit) => Promise<Response>): ReturnType<typeof vi.fn> => {
  const fn = vi.fn(impl);

  vi.stubGlobal('fetch', fn);

  return fn;
};

const okResponse = (body: object = { inserted: 0 }): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const errResponse = (status: number, body: string = ''): Response =>
  new Response(body, { status });

const makeTask = (table: BitmexTable, date: string = '20240315', stopSignal?: StopSignal): Task =>
  new Task({
    table, date,
    skip:       0,
    intervalMs: 60_000,
    stopSignal: stopSignal ?? { triggered: false },
  });

const makeItem = (task: Task, position: number, content?: string, size?: number): Item => {
  const body = content ?? '{"symbol":"XBTUSD","price":100,"size":1}';

  return {
    task,
    position,
    content: body,
    size:    size ?? body.length,
  };
};

/** Mirror what infer/assemble do for each item: claim Gate A + bump task.pending. */
const admitItems = async (task: Task, n: number): Promise<void> => {
  await admit(n);
  for (let i = 0; i < n; i++) task.admit();
};

const FLUSH_INTERVAL = 50;
const WRITER_URL     = 'http://writer';
const CAP            = 100_000;

beforeEach(() => {
  vi.useFakeTimers();
  resetInflight();
  initInflight(CAP);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── buildBody — wire body produced from item.content + injected _id ───────────

describe('buildBody — injects _id and assembles a JSON-array body', () => {
  it('produces a single-element JSON array with _id at the front', () => {
    const task = makeTask('trade', '20240315');
    const item = makeItem(task, 42, '{"symbol":"XBTUSD","price":100}');

    const body   = buildBody([item]);
    const parsed = JSON.parse(body) as Array<{ _id: number; symbol: string; price: number }>;

    expect(parsed).toHaveLength(1);
    expect(parsed[0]!._id).toBe(makeMongoId('20240315', 42));
    expect(parsed[0]!.symbol).toBe('XBTUSD');
    expect(parsed[0]!.price).toBe(100);
  });

  it('produces a multi-element JSON array with each item carrying its own _id', () => {
    const task  = makeTask('trade', '20240315');
    const items = [
      makeItem(task, 1, '{"symbol":"A"}'),
      makeItem(task, 2, '{"symbol":"B"}'),
      makeItem(task, 3, '{"symbol":"C"}'),
    ];

    const body   = buildBody(items);
    const parsed = JSON.parse(body) as Array<{ _id: number; symbol: string }>;

    expect(parsed.map(d => d.symbol)).toEqual(['A', 'B', 'C']);
    expect(parsed.map(d => d._id)).toEqual([
      makeMongoId('20240315', 1),
      makeMongoId('20240315', 2),
      makeMongoId('20240315', 3),
    ]);
  });
});

// ── sliceCount — byte-based batching ──────────────────────────────────────────

describe('sliceCount — caps batches by byte size, never below one item', () => {
  it('packs as many items as fit under the byte cap', () => {
    const task = makeTask('trade');

    /** Three small items — well under MAX_BYTES_PER_REQUEST. */
    const items = [
      makeItem(task, 1, undefined, 100_000),
      makeItem(task, 2, undefined, 100_000),
      makeItem(task, 3, undefined, 100_000),
    ];

    expect(sliceCount(items)).toBe(3);
  });

  it('stops before adding an item that would overflow the cap', () => {
    const task = makeTask('trade');

    const half     = Math.floor(MAX_BYTES_PER_REQUEST / 2);
    const overflow = MAX_BYTES_PER_REQUEST - 2 * half + 1;

    /** First two add to ~MAX − 1 bytes; the third (any positive size) tips
     *  over → stop at index 2. */
    const items = [
      makeItem(task, 1, undefined, half),
      makeItem(task, 2, undefined, half - 1),
      makeItem(task, 3, undefined, overflow + 100),
    ];

    expect(sliceCount(items)).toBe(2);
  });

  it('always returns at least 1 even when the first item alone exceeds the cap', () => {
    const task = makeTask('orderBookL2');

    /** A single oversize partial — exceeds MAX_BYTES_PER_REQUEST by itself.
     *  Must still ship alone so progress can be made. */
    const items = [
      makeItem(task, 1, undefined, MAX_BYTES_PER_REQUEST + 1_000_000),
      makeItem(task, 2, undefined, 100),
    ];

    expect(sliceCount(items)).toBe(1);
    expect(items[0]!.size).toBeGreaterThan(MAX_BYTES_PER_REQUEST);
  });
});

// ── No-op when batches empty ──────────────────────────────────────────────────

describe('startFlush — no-op when batches are empty', () => {
  it('does not POST when nothing is queued', async () => {
    const fetchSpy = mockFetch(async () => okResponse());

    const batches: TableBatches = new Map();
    const timer = startFlush(WRITER_URL, batches, FLUSH_INTERVAL, CAP);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL * 5);

    expect(fetchSpy).not.toHaveBeenCalled();
    clearInterval(timer);
  });
});

// ── Successful POST path ──────────────────────────────────────────────────────

describe('startFlush — successful POST', () => {
  it('posts all queued items and advances the task frontier', async () => {
    const task   = makeTask('trade');
    const items  = [makeItem(task, 1), makeItem(task, 2), makeItem(task, 3)];

    let postedBody: unknown[] = [];

    const fetchSpy = mockFetch(async (_url, init) => {
      postedBody = JSON.parse(init.body as string) as unknown[];
      return okResponse({ inserted: postedBody.length });
    });

    const batches: TableBatches = new Map([[task.table, items.slice()]]);

    await admitItems(task, items.length);

    const timer = startFlush(WRITER_URL, batches, FLUSH_INTERVAL, CAP);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(postedBody).toHaveLength(3);
    expect((postedBody as { _id: number }[])[0]!._id).toBe(makeMongoId(task.date, 1));
    expect(task.messages).toBe(3);
    expect(task.pending).toBe(0);

    clearInterval(timer);
  });

  it('posts to /write/<table>', async () => {
    const task  = makeTask('orderBookL2');
    const items = [makeItem(task, 1)];

    const fetchSpy = mockFetch(async () => okResponse());

    const batches: TableBatches = new Map([[task.table, items]]);

    await admitItems(task, 1);

    const timer = startFlush(WRITER_URL, batches, FLUSH_INTERVAL, CAP);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSpy).toHaveBeenCalledWith(`${WRITER_URL}/write/orderBookL2`, expect.any(Object));
    clearInterval(timer);
  });
});

// ── Duplicate-key handled writer-side ─────────────────────────────────────────

describe('startFlush — duplicate batches', () => {
  it('writer reports duplicates as 200 → farmer treats it as success', async () => {
    const task  = makeTask('trade');
    const items = [makeItem(task, 1)];

    mockFetch(async () => okResponse({ inserted: 0, duplicates: true }));

    const batches: TableBatches = new Map([[task.table, items]]);

    await admitItems(task, 1);

    const timer = startFlush(WRITER_URL, batches, FLUSH_INTERVAL, CAP);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
    await vi.advanceTimersByTimeAsync(0);

    expect(task.messages).toBe(1);
    expect(task.pending).toBe(0);

    clearInterval(timer);
  });
});

// ── Transient error → retry → success ─────────────────────────────────────────

describe('startFlush — transient error retry', () => {
  it('retries after the initial backoff and succeeds', async () => {
    const task  = makeTask('trade');
    const items = [makeItem(task, 1)];

    let attempts = 0;

    const fetchSpy = mockFetch(async () => {
      attempts++;

      if (attempts < 2) return errResponse(500, 'transient');

      return okResponse();
    });

    const batches: TableBatches = new Map([[task.table, items]]);

    await admitItems(task, 1);

    const timer = startFlush(WRITER_URL, batches, FLUSH_INTERVAL, CAP);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(task.messages).toBe(0); /** retry hasn't happened yet */

    await vi.advanceTimersByTimeAsync(RETRY_INITIAL_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(task.messages).toBe(1);
    expect(task.pending).toBe(0);

    clearInterval(timer);
  });
});

// ── Shutdown during retry ─────────────────────────────────────────────────────

describe('startFlush — shutdown', () => {
  it('abandons the batch without advancing the task when stopSignal triggers mid-retry', async () => {
    const stopSignal: StopSignal = { triggered: false };
    const task                   = makeTask('trade', '20240315', stopSignal);
    const items                  = [makeItem(task, 1)];

    mockFetch(async () => errResponse(500, 'persistent'));

    const batches: TableBatches = new Map([[task.table, items]]);

    await admitItems(task, 1);

    const timer = startFlush(WRITER_URL, batches, FLUSH_INTERVAL, CAP);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
    await vi.advanceTimersByTimeAsync(0);

    stopSignal.triggered = true;

    await vi.advanceTimersByTimeAsync(RETRY_INITIAL_MS);
    await vi.advanceTimersByTimeAsync(0);

    /** Item never confirmed → frontier stays at 0, pending stays at 1. */
    expect(task.messages).toBe(0);
    expect(task.pending).toBe(1);

    clearInterval(timer);
  });
});

// ── wireBytesCap ──────────────────────────────────────────────────────────────

describe('startFlush — wireBytesCap', () => {
  it('pauses flushing when the cap is reached and resumes when a POST completes', async () => {
    const task  = makeTask('trade');
    const first = makeItem(task, 1);

    let release!: () => void;

    const fetchSpy = mockFetch(() => new Promise<Response>(r => { release = () => r(okResponse()); }));

    const batches: TableBatches = new Map([[task.table, [first]]]);

    await admitItems(task, 1);

    /** cap = exactly one item's worth of bytes → only one in flight at a time. */
    const timer = startFlush(WRITER_URL, batches, FLUSH_INTERVAL, first.size);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    /** Queue another item — cap is still full, so the next tick should not flush. */
    batches.get(task.table)!.push(makeItem(task, 2));
    await admitItems(task, 1);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL * 3);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    /** Release the first; cap frees and the next tick flushes the second. */
    release();
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSpy).toHaveBeenCalledTimes(2);

    clearInterval(timer);
  });

  it('different tables flush concurrently when the cap allows it', async () => {
    const tradeTask = makeTask('trade');
    const obTask    = makeTask('orderBookL2');

    const fetchSpy = mockFetch(async () => okResponse());

    const batches: TableBatches = new Map([
      [tradeTask.table, [makeItem(tradeTask, 1)]],
      [obTask.table,    [makeItem(obTask, 1)]],
    ]);

    await admitItems(tradeTask, 1);
    await admitItems(obTask, 1);

    const timer = startFlush(WRITER_URL, batches, FLUSH_INTERVAL, CAP);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSpy).toHaveBeenCalledTimes(2);

    clearInterval(timer);
  });

  it('starts multiple concurrent POSTs on the same table while the cap allows it', async () => {
    /** Per-table serialization is gone — two batches' worth of items on the
     *  same table should produce two in-flight requests. */
    const task = makeTask('trade');

    const releases: Array<() => void> = [];

    const fetchSpy = mockFetch(() => new Promise<Response>(r => {
      releases.push(() => r(okResponse()));
    }));

    const list: Item[] = [makeItem(task, 1)];
    const batches: TableBatches = new Map([[task.table, list]]);

    await admitItems(task, 1);

    const timer = startFlush(WRITER_URL, batches, FLUSH_INTERVAL, CAP);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    /** Now add another item — it should flush even though the first is still in flight. */
    list.push(makeItem(task, 2));
    await admitItems(task, 1);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSpy).toHaveBeenCalledTimes(2);

    releases.forEach(r => r());

    clearInterval(timer);
  });
});
