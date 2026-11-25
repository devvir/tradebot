import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/fs/writer', () => ({
  appendBatch:   vi.fn(() => Promise.resolve()),
  isInitialized: vi.fn(() => false),
}));

vi.mock('../../src/fs/health', () => ({
  recordFailure: vi.fn(),
}));

import { _test_tick } from '../../src/data/ticker';
import { buffers, _test_reset } from '../../src/data/buffers';
import { appendBatch, isInitialized } from '../../src/fs/writer';
import { recordFailure } from '../../src/fs/health';
import { TABLE_HEADERS } from '../../src/data/headers';

beforeEach(() => {
  _test_reset();
  vi.clearAllMocks();
  vi.mocked(isInitialized).mockReturnValue(false);
  vi.mocked(appendBatch).mockResolvedValue(undefined);
});

const fill = (table: string, filename: string): void => {
  // Stuff the buffer to BATCH_SIZE so flushReady picks it up.
  const buf = buffers.get(table, filename);
  for (let i = 0; i < 10_000; i++) buf.push(`row-${i}`);
};

describe('ticker.tick', () => {
  it('does nothing when no buffer is ready', () => {
    _test_tick();
    expect(appendBatch).not.toHaveBeenCalled();
  });

  it('prepends the header line when the file is not yet initialised', () => {
    fill('orderBookL2', '20230201');

    _test_tick();

    expect(appendBatch).toHaveBeenCalledTimes(1);
    const [table, filename, lines] = vi.mocked(appendBatch).mock.calls[0]!;
    expect(table).toBe('orderBookL2');
    expect(filename).toBe('20230201');
    expect(lines[0]).toBe(TABLE_HEADERS['orderBookL2']!.join(','));
    expect(lines.length).toBe(10_001);
  });

  it('passes a suffixed filename straight through to appendBatch', () => {
    fill('orderBookL2', '20230201.snapshot');

    _test_tick();

    const [table, filename] = vi.mocked(appendBatch).mock.calls[0]!;
    expect(table).toBe('orderBookL2');
    expect(filename).toBe('20230201.snapshot');
  });

  it('does not prepend the header when the file is already initialised', () => {
    vi.mocked(isInitialized).mockReturnValue(true);

    fill('orderBookL2', '20230201');

    _test_tick();

    const [, , lines] = vi.mocked(appendBatch).mock.calls[0]!;
    expect(lines.length).toBe(10_000);
    expect(lines[0]).toBe('row-0');
  });

  it('logs and continues flushing other tables when a table has no header definition', async () => {
    fill('unknownTable', '20230201');
    fill('trade',        '20230201');

    expect(() => _test_tick()).not.toThrow();

    expect(appendBatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(appendBatch).mock.calls[0]![0]).toBe('trade');

    await vi.waitFor(() => expect(recordFailure).toHaveBeenCalledTimes(1));
    expect(vi.mocked(recordFailure).mock.calls[0]![0]).toMatch(/unknownTable\/20230201/);
  });

  it('does not throw when a write throws synchronously, and records the failure', async () => {
    vi.mocked(appendBatch).mockImplementation(() => { throw new Error('ENOTDIR'); });

    fill('trade', '20230201');
    fill('tick',  '20230201');

    expect(() => _test_tick()).not.toThrow();

    expect(appendBatch).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(recordFailure).toHaveBeenCalledTimes(2));
  });
});
