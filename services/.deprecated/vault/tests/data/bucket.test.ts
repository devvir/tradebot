import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/fs/writer', () => ({
  appendBatch:   vi.fn(() => Promise.resolve()),
  isInitialized: vi.fn(() => false),
  deleteFile:    vi.fn(() => Promise.resolve()),
  storeFile:     vi.fn(() => Promise.resolve()),
}));

import { Readable } from 'stream';
import {
  writeLines, markClosing, isClosing, acceptsRows, bucketState, discardBucket, uploadBucket,
  BucketBusyError, _test_reset,
} from '../../src/data/bucket';
import { buffers, _test_reset as resetBuffers } from '../../src/data/buffers';
import { appendBatch, isInitialized, deleteFile, storeFile } from '../../src/fs/writer';
import { TABLE_HEADERS } from '../../src/data/headers';

/** A promise plus the function that settles it. */
const deferred = () => {
  let resolve!: () => void;
  let reject!:  (err: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });

  return { promise, resolve, reject };
};

const HEADER = TABLE_HEADERS['trade']!.join(',');

beforeEach(() => {
  _test_reset();
  resetBuffers();
  vi.clearAllMocks();
  vi.mocked(isInitialized).mockReturnValue(false);
  vi.mocked(appendBatch).mockResolvedValue(undefined);
  vi.mocked(deleteFile).mockResolvedValue(undefined);
  vi.mocked(storeFile).mockResolvedValue(undefined);
});

describe('writeLines', () => {
  it('prepends the header line when the file is not yet initialised', async () => {
    await writeLines('trade', '20230201', ['a', 'b']);

    expect(appendBatch).toHaveBeenCalledWith('trade', '20230201', [HEADER, 'a', 'b'], false);
  });

  it('does not prepend the header when the file is already initialised', async () => {
    vi.mocked(isInitialized).mockReturnValue(true);

    await writeLines('trade', '20230201', ['a'], true);

    expect(appendBatch).toHaveBeenCalledWith('trade', '20230201', ['a'], true);
  });

  it('hands the batch to the writer synchronously, within the call', () => {
    void writeLines('trade', '20230201', ['a']);

    expect(appendBatch).toHaveBeenCalledTimes(1);
  });

  it('rejects, without writing, when the table has no header definition', async () => {
    const result = writeLines('unknownTable', '20230201', ['a']);

    await expect(result).rejects.toThrow(/No header definition for table 'unknownTable'/);
    expect(appendBatch).not.toHaveBeenCalled();
  });

  it('rejects when the writer throws synchronously', async () => {
    vi.mocked(appendBatch).mockImplementation(() => { throw new Error('ENOTDIR'); });

    await expect(writeLines('trade', '20230201', ['a'])).rejects.toThrow('ENOTDIR');
  });
});

describe('closing state', () => {
  it('refuses rows while closing and accepts them after release', () => {
    expect(acceptsRows('trade', '20230201')).toBe(true);

    const release = markClosing('trade', '20230201');

    expect(isClosing('trade', '20230201')).toBe(true);
    expect(acceptsRows('trade', '20230201')).toBe(false);
    expect(acceptsRows('trade', '20230202')).toBe(true);

    release();

    expect(isClosing('trade', '20230201')).toBe(false);
    expect(acceptsRows('trade', '20230201')).toBe(true);
  });

  it('stays closing until every overlapping close has released', () => {
    const first  = markClosing('trade', '20230201');
    const second = markClosing('trade', '20230201');

    first();
    first(); // a repeated release has no further effect

    expect(isClosing('trade', '20230201')).toBe(true);

    second();

    expect(isClosing('trade', '20230201')).toBe(false);
  });
});

describe('discardBucket', () => {
  it('drops buffered rows and the open file', async () => {
    buffers.get('trade', '20230201').pushMany(['a', 'b']);

    await discardBucket('trade', '20230201');

    expect(deleteFile).toHaveBeenCalledWith('trade', '20230201');
    expect(buffers.flushAll()).toEqual([]);
  });

  it('holds the bucket as discarding until the open file is gone', async () => {
    const removal = deferred();
    vi.mocked(deleteFile).mockReturnValueOnce(removal.promise);

    const pending = discardBucket('trade', '20230201');

    expect(bucketState('trade', '20230201')).toBe('discarding');
    expect(acceptsRows('trade', '20230201')).toBe(false);
    expect(acceptsRows('trade', '20230202')).toBe(true);
    expect(() => markClosing('trade', '20230201')).toThrow(BucketBusyError);
    await expect(discardBucket('trade', '20230201')).rejects.toBeInstanceOf(BucketBusyError);
    await expect(uploadBucket('trade', '20230201', Readable.from([]))).rejects.toBeInstanceOf(BucketBusyError);
    expect(deleteFile).toHaveBeenCalledTimes(1);

    removal.resolve();
    await pending;

    expect(bucketState('trade', '20230201')).toBe('idle');
  });

  it('releases the bucket when removing the open file fails', async () => {
    vi.mocked(deleteFile).mockRejectedValueOnce(new Error('EACCES'));

    await expect(discardBucket('trade', '20230201')).rejects.toThrow('EACCES');

    expect(bucketState('trade', '20230201')).toBe('idle');
  });

  it('refuses a closing bucket without touching it', async () => {
    markClosing('trade', '20230201');
    buffers.get('trade', '20230201').push('a');

    await expect(discardBucket('trade', '20230201')).rejects.toBeInstanceOf(BucketBusyError);

    expect(deleteFile).not.toHaveBeenCalled();
    expect(buffers.get('trade', '20230201').count()).toBe(1);
  });
});

describe('uploadBucket', () => {
  it('drops the open file, then stores the source', async () => {
    const source = Readable.from([Buffer.from('x')]);

    await uploadBucket('trade', '20230201', source);

    expect(deleteFile).toHaveBeenCalledWith('trade', '20230201');
    expect(storeFile).toHaveBeenCalledWith('trade', '20230201', source);
    expect(vi.mocked(deleteFile).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(storeFile).mock.invocationCallOrder[0]!);
  });

  it('holds the bucket as uploading until the store settles, even when it fails', async () => {
    const store = deferred();
    vi.mocked(storeFile).mockReturnValueOnce(store.promise);

    const pending = uploadBucket('trade', '20230201', Readable.from([]));

    expect(bucketState('trade', '20230201')).toBe('uploading');
    expect(acceptsRows('trade', '20230201')).toBe(false);
    await expect(uploadBucket('trade', '20230201', Readable.from([]))).rejects.toBeInstanceOf(BucketBusyError);

    store.reject(new Error('invalid'));
    await expect(pending).rejects.toThrow('invalid');

    expect(bucketState('trade', '20230201')).toBe('idle');
  });

  it('refuses a closing bucket without reading the source', async () => {
    markClosing('trade', '20230201');

    await expect(uploadBucket('trade', '20230201', Readable.from([]))).rejects.toBeInstanceOf(BucketBusyError);

    expect(deleteFile).not.toHaveBeenCalled();
    expect(storeFile).not.toHaveBeenCalled();
  });
});
