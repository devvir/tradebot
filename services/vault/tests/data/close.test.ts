import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/fs/writer', () => ({
  appendBatch:   vi.fn(() => Promise.resolve()),
  isInitialized: vi.fn(() => false),
  deleteFile:    vi.fn(() => new Promise(() => {})),
}));

import { closeBucket } from '../../src/data/close';
import { buffers, _test_reset } from '../../src/data/buffers';
import { isClosing, discardBucket, BucketBusyError, _test_reset as resetBucket } from '../../src/data/bucket';
import { appendBatch, isInitialized } from '../../src/fs/writer';
import { TABLE_HEADERS } from '../../src/data/headers';

beforeEach(() => {
  _test_reset();
  resetBucket();
  vi.clearAllMocks();
  vi.mocked(isInitialized).mockReturnValue(false);
  vi.mocked(appendBatch).mockResolvedValue(undefined);
});

describe('closeBucket', () => {
  it('is a no-op when there is nothing to flush and no file on disk', async () => {
    await closeBucket('trade', '2023-02-01');
    expect(appendBatch).not.toHaveBeenCalled();
  });

  it('flushes the buffer and seals (file already initialised on disk → no header)', async () => {
    vi.mocked(isInitialized).mockReturnValue(true);

    const buf = buffers.get('orderBookL2', '2023-02-01');
    buf.push('row-1');
    buf.push('row-2');

    await closeBucket('orderBookL2', '2023-02-01');

    expect(appendBatch).toHaveBeenCalledWith('orderBookL2', '2023-02-01', ['row-1', 'row-2'], true);
    expect(buf.count()).toBe(0);
  });

  it('prepends the header line when no file is yet initialised', async () => {
    const buf = buffers.get('orderBookL2', '2023-02-01');
    buf.push('row-1');

    await closeBucket('orderBookL2', '2023-02-01');

    const expectedHeader = TABLE_HEADERS['orderBookL2']!.join(',');
    expect(appendBatch).toHaveBeenCalledWith('orderBookL2', '2023-02-01', [expectedHeader, 'row-1'], true);
  });

  it('seals an empty buffer if the file already exists on disk (header was written)', async () => {
    vi.mocked(isInitialized).mockReturnValue(true);

    await closeBucket('orderBookL2', '2023-02-01');

    expect(appendBatch).toHaveBeenCalledWith('orderBookL2', '2023-02-01', [], true);
  });

  it('marks the bucket closing synchronously and releases it when the seal resolves', async () => {
    vi.mocked(isInitialized).mockReturnValue(true);

    let finish!: () => void;
    vi.mocked(appendBatch).mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));

    const closed = closeBucket('orderBookL2', '20230201');

    expect(isClosing('orderBookL2', '20230201')).toBe(true);

    finish();
    await closed;

    expect(isClosing('orderBookL2', '20230201')).toBe(false);
  });

  it('releases the closing mark when the seal fails', async () => {
    vi.mocked(isInitialized).mockReturnValue(true);
    vi.mocked(appendBatch).mockRejectedValue(new Error('rename failed'));

    await expect(closeBucket('orderBookL2', '20230201')).rejects.toThrow('rename failed');

    expect(isClosing('orderBookL2', '20230201')).toBe(false);
  });

  it('rejects (and releases the mark) when the table has no header definition', async () => {
    buffers.get('unknownTable', '20230201').push('row-1');

    await expect(closeBucket('unknownTable', '20230201')).rejects.toThrow(/No header definition/);

    expect(isClosing('unknownTable', '20230201')).toBe(false);
  });

  it('rejects without sealing or draining while the bucket is being discarded', async () => {
    vi.mocked(isInitialized).mockReturnValue(true);
    void discardBucket('orderBookL2', '20230201');
    buffers.get('orderBookL2', '20230201').push('row-1');

    await expect(closeBucket('orderBookL2', '20230201')).rejects.toBeInstanceOf(BucketBusyError);

    expect(appendBatch).not.toHaveBeenCalled();
    expect(buffers.get('orderBookL2', '20230201').count()).toBe(1);
    expect(isClosing('orderBookL2', '20230201')).toBe(false);
  });
});
