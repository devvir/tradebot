import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/fs/writer', () => ({
  appendBatch:   vi.fn(() => Promise.resolve()),
  isInitialized: vi.fn(() => false),
}));

import { _test_tick } from '../../src/data/ticker';
import { buffers, _test_reset } from '../../src/data/buffers';
import { appendBatch, isInitialized } from '../../src/fs/writer';
import { TABLE_HEADERS } from '../../src/data/headers';

beforeEach(() => {
  _test_reset();
  vi.clearAllMocks();
  vi.mocked(isInitialized).mockReturnValue(false);
  vi.mocked(appendBatch).mockResolvedValue(undefined);
});

describe('ticker.tick', () => {
  it('does nothing when no buffer is ready', () => {
    _test_tick();
    expect(appendBatch).not.toHaveBeenCalled();
  });

  it('prepends the header line when the file is not yet initialised', () => {
    // Stuff the buffer past BATCH_SIZE so flushReady picks it up.
    const buf = buffers.get('orderBookL2', '2023-02-01');
    for (let i = 0; i < 10_000; i++) buf.push(`row-${i}`);

    _test_tick();

    expect(appendBatch).toHaveBeenCalledTimes(1);
    const [table, date, lines] = vi.mocked(appendBatch).mock.calls[0]!;
    expect(table).toBe('orderBookL2');
    expect(date).toBe('2023-02-01');
    expect(lines[0]).toBe(TABLE_HEADERS['orderBookL2']!.join(','));
    expect(lines.length).toBe(10_001);
  });

  it('does not prepend the header when the file is already initialised', () => {
    vi.mocked(isInitialized).mockReturnValue(true);

    const buf = buffers.get('orderBookL2', '2023-02-01');
    for (let i = 0; i < 10_000; i++) buf.push(`row-${i}`);

    _test_tick();

    const [, , lines] = vi.mocked(appendBatch).mock.calls[0]!;
    expect(lines.length).toBe(10_000);
    expect(lines[0]).toBe('row-0');
  });

  it('throws on the buffered table when no header definition exists', () => {
    const buf = buffers.get('unknownTable', '2023-02-01');
    for (let i = 0; i < 10_000; i++) buf.push(`row-${i}`);

    expect(() => _test_tick()).toThrow(/No header definition/);
  });
});
