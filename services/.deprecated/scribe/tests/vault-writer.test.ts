import { describe, it, expect, vi, afterEach } from 'vitest';
import { createBufferedWriter } from '../src/vault';
import type { StoreService } from '../src/vault';

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeStore = (overrides: Partial<StoreService> = {}): StoreService => ({
  writeRows:  vi.fn().mockResolvedValue(undefined),
  closeFile:  vi.fn().mockResolvedValue(undefined),
  deleteFile: vi.fn().mockResolvedValue(undefined),
  listFiles:  vi.fn().mockResolvedValue({}),
  ...overrides,
});

const row = (n: number) => ({ n });

// ── Buffering ─────────────────────────────────────────────────────────────────

describe('BufferedWriter — buffering', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not write when nothing is pushed', async () => {
    const store  = makeStore();
    const writer = createBufferedWriter(store, 'funding', '20200101', 10);

    await writer.close();

    expect(store.writeRows).not.toHaveBeenCalled();
  });

  it('writes a single batch on close when buffer is below threshold', async () => {
    const store  = makeStore();
    const writer = createBufferedWriter(store, 'funding', '20200101', 10);

    for (let i = 0; i < 5; i++) await writer.push(row(i));
    await writer.close();

    expect(store.writeRows).toHaveBeenCalledTimes(1);
    expect(store.writeRows).toHaveBeenCalledWith(
      'funding', '20200101',
      [row(0), row(1), row(2), row(3), row(4)],
    );
  });

  it('flushes at threshold and again on close', async () => {
    const store  = makeStore();
    const writer = createBufferedWriter(store, 'funding', '20200101', 3);

    for (let i = 0; i < 5; i++) await writer.push(row(i));
    await writer.close();

    expect(store.writeRows).toHaveBeenCalledTimes(2);
    expect(store.writeRows).toHaveBeenNthCalledWith(1, 'funding', '20200101', [row(0), row(1), row(2)]);
    expect(store.writeRows).toHaveBeenNthCalledWith(2, 'funding', '20200101', [row(3), row(4)]);
  });

  it('does not write a trailing empty batch when buffer hits threshold exactly', async () => {
    const store  = makeStore();
    const writer = createBufferedWriter(store, 'funding', '20200101', 3);

    for (let i = 0; i < 6; i++) await writer.push(row(i));
    await writer.close();

    expect(store.writeRows).toHaveBeenCalledTimes(2);
  });
});

// ── Pipelining ────────────────────────────────────────────────────────────────

describe('BufferedWriter — pipelining', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not block push on an in-flight write below threshold', async () => {
    let resolveWrite: () => void = () => {};
    const inFlight = new Promise<void>((r) => { resolveWrite = r; });

    const store = makeStore({
      writeRows: vi.fn().mockReturnValueOnce(inFlight),
    });
    const writer = createBufferedWriter(store, 'funding', '20200101', 2);

    // First two rows trigger a flush — write is in flight, never resolved.
    await writer.push(row(0));
    await writer.push(row(1));

    expect(store.writeRows).toHaveBeenCalledTimes(1);

    // Pushing a third row (below threshold) must not wait for the in-flight write.
    let resolved = false;
    await writer.push(row(2)).then(() => { resolved = true; });

    expect(resolved).toBe(true);

    resolveWrite();
  });

  it('starts the next write only after the previous one resolves', async () => {
    const events: string[] = [];

    let resolveFirst: () => void = () => {};
    const firstWrite = new Promise<void>((r) => { resolveFirst = r; });

    const store = makeStore({
      writeRows: vi.fn()
        .mockImplementationOnce(() => {
          events.push('w1-start');
          return firstWrite.then(() => { events.push('w1-end'); });
        })
        .mockImplementationOnce(() => {
          events.push('w2-start');
          return Promise.resolve();
        }),
    });
    const writer = createBufferedWriter(store, 'funding', '20200101', 2);

    await writer.push(row(0));
    await writer.push(row(1)); // triggers write1 (in flight)
    await writer.push(row(2));

    // This push fills the buffer to threshold and must wait for write1.
    const push4 = writer.push(row(3));

    // Yield microtasks; write1 is still pending so write2 has not started.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['w1-start']);

    resolveFirst();
    await push4;

    expect(events).toEqual(['w1-start', 'w1-end', 'w2-start']);
  });

  it('drains the in-flight write on close', async () => {
    const events: string[] = [];

    let resolveWrite: () => void = () => {};
    const inFlight = new Promise<void>((r) => { resolveWrite = r; });

    const store = makeStore({
      writeRows: vi.fn().mockImplementation(() => {
        events.push('write-start');
        return inFlight.then(() => { events.push('write-end'); });
      }),
    });
    const writer = createBufferedWriter(store, 'funding', '20200101', 2);

    await writer.push(row(0));
    await writer.push(row(1)); // triggers write (in flight)

    let closed = false;
    const closing = writer.close().then(() => { closed = true; });

    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);

    resolveWrite();
    await closing;

    expect(closed).toBe(true);
    expect(events).toEqual(['write-start', 'write-end']);
  });

  it('propagates a failed write on close', async () => {
    const store = makeStore({
      writeRows: vi.fn().mockRejectedValue(new Error('vault down')),
    });
    const writer = createBufferedWriter(store, 'funding', '20200101', 10);

    await writer.push(row(0));

    await expect(writer.close()).rejects.toThrow('vault down');
  });
});
